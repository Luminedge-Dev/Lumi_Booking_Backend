// Stage 15 differential parity: Schedule.
//
// The SAME fixtures run through (a) the frozen pre-Stage-15 Mongo repository
// against a real ephemeral MongoDB and (b) the Stage 15 PostgreSQL repository
// against the real stage13-dev database. Differences must be declared with a
// reason (assertParity fails on any undeclared one).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaScheduleRepository } from "../../src/app/modules/schedule/schedule.repository";
import { ScheduleService } from "../../src/app/modules/schedule/schedule.service";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { MongoScheduleReference } from "./reference-mongo/schedule.reference";
import { assertParity, newTestObjectId, PARITY_ID_PREFIX, toWire } from "./helpers/compare";

const COURSE = newTestObjectId().toHexString();
const OTHER_COURSE = newTestObjectId().toHexString();
const created = new Date("2026-10-01T02:03:04.567Z");

type Doc = Record<string, unknown> & { _id: ObjectId };

function doc(over: Record<string, unknown> = {}): Doc {
  return {
    _id: newTestObjectId(),
    courseId: COURSE,
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    name: "Parity IELTS",
    testSystem: "",
    testType: "Computer-Based",
    status: "Scheduled",
    timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 12, slotId: "1" }],
    createdAt: created,
    ...over,
  };
}

function slotsOf(over: string[]): Array<Record<string, unknown>> {
  return over.map((slotId, i) => ({ startTime: `0${i + 1}:00:00`, endTime: `0${i + 1}:30:00`, slot: 5, totalSlot: 6, slotId }));
}

describe("Stage 15 parity: Schedule repository (Mongo reference vs PostgreSQL)", () => {
  let mongo: TransactionTestDb;
  const pg = new PrismaScheduleRepository();
  let ref: MongoScheduleReference;

  async function cleanupPg(): Promise<void> {
    const prisma = getPrismaClient();
    const rows = await prisma.schedule.findMany({ where: { courseId: { startsWith: PARITY_ID_PREFIX } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    await prisma.scheduleSlot.deleteMany({ where: { scheduleId: { in: ids } } });
    await prisma.slotCounter.deleteMany({ where: { scheduleId: { in: ids } } });
    await prisma.schedule.deleteMany({ where: { id: { in: ids } } });
  }

  // Loads a Mongo-shaped document into PostgreSQL the way Stage 14 would.
  async function loadBoth(docs: Doc[]): Promise<void> {
    const sorted = [...docs].sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()));
    await mongo.collections.schedulesCollection.insertMany(sorted.map((d) => ({ ...d })));
    const prisma = getPrismaClient();
    for (const d of sorted) {
      const id = d._id.toHexString();
      const slots = d.timeSlots as Array<Record<string, unknown>>;
      await prisma.schedule.create({
        data: {
          id,
          name: d.name as string,
          courseId: d.courseId as string,
          startDate: new Date(`${d.startDate}T00:00:00.000Z`),
          endDate: new Date(`${d.endDate}T00:00:00.000Z`),
          testType: d.testType === "Computer-Based" ? "ComputerBased" : "PaperBased",
          testSystem: (d.testSystem as string | undefined) ?? null,
          status: d.status as "Scheduled" | "Cancelled",
          createdAt: d.createdAt as Date,
        },
      });
      if (slots.length > 0) {
        await prisma.scheduleSlot.createMany({
          data: slots.map((s, position) => ({
            scheduleId: id,
            position,
            slotId: String(s.slotId),
            seatsLeft: s.slot as number,
            capacityTotal: s.totalSlot as number,
            startTime: s.startTime as string,
            endTime: s.endTime as string,
          })),
        });
      }
    }
  }

  before(async () => {
    assertStage13Target();
    mongo = await startTransactionTestDb();
    ref = new MongoScheduleReference(mongo.collections.schedulesCollection);
    await cleanupPg();
  });

  after(async () => {
    await cleanupPg().catch(() => undefined);
    await disconnectPrisma();
    await mongo?.teardown();
  });

  async function reset(): Promise<void> {
    await mongo.collections.schedulesCollection.deleteMany({});
    await cleanupPg();
  }

  it("daily read: same records, same numeric slot ordering ('2' < '10'), Cancelled and other days/courses excluded", async () => {
    await reset();
    const ten = doc({ timeSlots: slotsOf(["10"]) });
    const two = doc({ timeSlots: slotsOf(["2"]) });
    const one = doc({ timeSlots: slotsOf(["1"]) });
    await loadBoth([
      ten,
      two,
      one,
      doc({ status: "Cancelled", timeSlots: slotsOf(["3"]) }),
      doc({ startDate: "2026-10-06", endDate: "2026-10-06" }),
      doc({ courseId: OTHER_COURSE }),
      doc({ startDate: "2026-10-05", endDate: "2026-10-06", timeSlots: slotsOf(["4"]) }),
    ]);
    const m = await ref.findByDateAndCourse("2026-10-05", COURSE);
    const p = await pg.findByDateAndCourse("2026-10-05", COURSE);
    assert.deepEqual(m.map((r) => String(r._id)), [one, two, ten].map((d) => d._id.toHexString()));
    assertParity(m, p, [], "daily read");
  });

  it("daily read: empty result and unknown course/date agree", async () => {
    assertParity(await ref.findByDateAndCourse("2027-01-01", COURSE), await pg.findByDateAndCourse("2027-01-01", COURSE), [], "empty day");
    assertParity(await ref.findByDateAndCourse("2026-10-05", "c1"), await pg.findByDateAndCourse("2026-10-05", "c1"), [], "unknown course");
  });

  it("monthly read: identical membership and boundaries", async () => {
    await reset();
    await loadBoth([
      doc({ startDate: "2026-09-30", endDate: "2026-09-30" }),
      doc({ startDate: "2026-10-01", endDate: "2026-10-01" }),
      doc({ startDate: "2026-10-31", endDate: "2026-10-31" }),
      doc({ startDate: "2026-11-01", endDate: "2026-11-01" }),
      doc({ startDate: "2026-10-15", endDate: "2026-10-15", status: "Cancelled" }),
      doc({ startDate: "2026-10-15", endDate: "2026-10-15", courseId: OTHER_COURSE }),
    ]);
    const range = { startInclusive: "2026-10-01", endExclusive: "2026-11-01" };
    const m = await ref.findByCourseAndMonth(COURSE, range);
    const p = await pg.findByCourseAndMonth(COURSE, range);
    assert.equal(m.length, 2);
    // Mongo returns natural (insertion) order; fixtures were inserted in id order, PostgreSQL orders by id.
    assertParity(m, p, [], "monthly read");
  });

  it("admin list + count: _id-desc order, pagination, filters, and unmatched filters agree", async () => {
    await reset();
    const docs = Array.from({ length: 5 }, (_, i) => doc({ startDate: `2026-10-0${i + 1}`, endDate: `2026-10-0${i + 1}` }));
    docs.push(doc({ status: "Cancelled" }), doc({ courseId: OTHER_COURSE }));
    await loadBoth(docs);
    const page = { page: 1, limit: 100, skip: 0 };
    const cases: Array<[string, { courseId?: string; status?: string }, { page: number; limit: number; skip: number }]> = [
      ["no filter", {}, page],
      ["course filter", { courseId: COURSE }, page],
      ["status filter", { status: "Cancelled" }, page],
      ["both filters", { courseId: COURSE, status: "Scheduled" }, page],
      ["page 2 of 3", {}, { page: 2, limit: 3, skip: 3 }],
      ["past the end", {}, { page: 9, limit: 3, skip: 24 }],
      ["unknown status", { status: "Draft" }, page],
      ["non-id course filter", { courseId: "c1" }, page],
    ];
    for (const [label, filter, params] of cases) {
      const m = await ref.listAdmin(filter, params);
      // stage13-dev also holds the real Stage 14 schedules (ids sort BELOW the
      // 0xffff5155 test ids, so descending pages start with our rows). Keep
      // only this suite's rows and subtract the others from the count.
      const p = (await pg.listAdmin(filter, params)).filter((r) => String(r.courseId).startsWith(PARITY_ID_PREFIX));
      assertParity(m, p, [], `list ${label}`);
      const foreign = await getPrismaClient().schedule.count({
        where: {
          NOT: { courseId: { startsWith: PARITY_ID_PREFIX } },
          ...(filter.status === "Scheduled" || filter.status === "Cancelled" ? { status: filter.status } : {}),
          ...(filter.courseId === undefined ? {} : { courseId: filter.courseId }),
        },
      });
      const foreignMatching = filter.status === "Draft" ? 0 : filter.courseId === "c1" ? 0 : foreign;
      assert.equal((await pg.countAdmin(filter)) - foreignMatching, await ref.countAdmin(filter), `count ${label}`);
    }
  });

  it("delete: same boolean outcomes (found, missing) and the row is gone afterwards", async () => {
    await reset();
    const d = doc();
    await loadBoth([d]);
    const missing = newTestObjectId().toHexString();
    assert.equal(await ref.deleteById(d._id.toHexString()), true);
    assert.equal(await pg.deleteById(d._id.toHexString()), true);
    assert.equal(await ref.deleteById(d._id.toHexString()), false);
    assert.equal(await pg.deleteById(d._id.toHexString()), false);
    assert.equal(await ref.deleteById(missing), false);
    assert.equal(await pg.deleteById(missing), false);
    assert.equal(await getPrismaClient().scheduleSlot.count({ where: { scheduleId: d._id.toHexString() } }), 0);
  });

  it("slot-id allocator: same maximum for the same key, same 0 when nothing matches", async () => {
    await reset();
    await loadBoth([doc({ timeSlots: slotsOf(["2"]) }), doc({ timeSlots: slotsOf(["10"]) }), doc({ testType: "Paper-Based", timeSlots: slotsOf(["50"]) })]);
    const key = { courseId: COURSE, startDate: "2026-10-05", endDate: "2026-10-05", testType: "Computer-Based" as const };
    assert.equal(await pg.findMaxSlotId(key), await ref.findMaxSlotId(key));
    assert.equal(await pg.findMaxSlotId(key), 10);
    const none = { ...key, startDate: "2030-01-01", endDate: "2030-01-01" };
    assert.equal(await pg.findMaxSlotId(none), await ref.findMaxSlotId(none));
  });

  it("INTENTIONAL: a non-numeric legacy slotId makes the Mongo allocator throw; PostgreSQL ignores it", async () => {
    await reset();
    await loadBoth([doc({ timeSlots: slotsOf(["7"]) }), doc({ timeSlots: slotsOf(["abc"]) })]);
    const key = { courseId: COURSE, startDate: "2026-10-05", endDate: "2026-10-05", testType: "Computer-Based" as const };
    await assert.rejects(() => ref.findMaxSlotId(key));
    assert.equal(await pg.findMaxSlotId(key), 7);
  });

  it("created through ScheduleService: PostgreSQL read-back equals what the Mongo-persisted document reads back as", async () => {
    await reset();
    const entry = {
      courseId: COURSE,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      testType: "Computer-Based",
      name: "Parity IELTS",
      testSystem: "",
      status: "Scheduled",
      timeSlots: [{ startTime: "09:00", endTime: "10:00", slot: 10, totalSlot: 12 }],
    };
    const result = await new ScheduleService(pg).createSchedules([entry]);
    assert.equal(result.successful[0].assignedSlotId, "1");
    // What the pre-Stage-15 service wrote to Mongo for the same entry.
    await mongo.collections.schedulesCollection.insertOne({
      courseId: COURSE,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      name: "Parity IELTS",
      testSystem: "",
      testType: "Computer-Based",
      status: "Scheduled",
      timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 12, slotId: "1" }],
      createdAt: result.successful[0].createdAt,
    });
    const m = await ref.findByDateAndCourse("2026-10-05", COURSE);
    const p = await pg.findByDateAndCourse("2026-10-05", COURSE);
    assert.equal(m.length, 1);
    assert.equal(p.length, 1);
    assertParity(m[0], p[0], [{ path: "_id", mongo: m[0]._id, postgres: p[0]._id, reason: "independently generated ids" }], "created record");
  });

  it("INTENTIONAL: unmodeled fields are not carried and numeric slotIds become strings", async () => {
    await reset();
    const d = doc({ emailsSent: true, timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 1, totalSlot: 1, slotId: 5 }] });
    await loadBoth([d]);
    const [m] = await ref.findByDateAndCourse("2026-10-05", COURSE);
    const [p] = await pg.findByDateAndCourse("2026-10-05", COURSE);
    assertParity(
      m,
      p,
      [
        { path: "emailsSent", mongo: true, postgres: undefined, reason: "field has no Stage 13 column (reported undeclared by Stage 14)" },
        { path: "timeSlots.0.slotId", mongo: 5, postgres: "5", reason: "canonical contract: slotId is a string (Stage 10.5/14)" },
      ],
      "unmodeled field"
    );  });

  it("INTENTIONAL: GET /schedule/:userId is empty in PostgreSQL (no userId column); Mongo matched raw userId strings", async () => {
    await reset();
    const userId = new ObjectId().toHexString();
    await mongo.collections.schedulesCollection.insertOne({ ...doc(), userId });
    assert.equal((await ref.findByUserId(userId)).length, 1);
    assert.deepEqual(await pg.findByUserId(userId), []);
    assert.deepEqual(toWire(await pg.findByUserId("anything")), []);
  });
});
