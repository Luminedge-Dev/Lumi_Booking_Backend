import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { runWithStatementTimeout } from "../../src/app/database/transaction";
import { runPersistence } from "../../src/app/database/persistence-error";
import { PrismaScheduleRepository } from "../../src/app/modules/schedule/schedule.repository";
import { ScheduleQueryTimeoutError } from "../../src/app/modules/schedule/schedule.types";
import type { NewScheduleRecord } from "../../src/app/modules/schedule/schedule.types";
import { assertStage13Target } from "./helpers/stage13-target";

// Every row this suite creates hangs off one of these course ids (valid
// ObjectId hex with the unmistakable 0xffff5155 timestamp prefix), so cleanup
// is exact and never touches Stage 14 data.
const PREFIX = "ffff5155";
const COURSE_A = `${PREFIX}aaaaaaaaaaaaaaaa`;
const COURSE_B = `${PREFIX}bbbbbbbbbbbbbbbb`;
const COURSE_MISSING = `${PREFIX}cccccccccccccccc`;

function newSchedule(overrides: Partial<NewScheduleRecord> = {}): NewScheduleRecord {
  return {
    courseId: COURSE_A,
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    name: "Stage 15 IELTS",
    testSystem: "",
    testType: "Computer-Based",
    status: "Scheduled",
    timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 12, slotId: "1" }],
    createdAt: new Date("2026-10-01T02:03:04.567Z"),
    ...overrides,
  };
}

describe("Stage 15 Schedule repository (live stage13-dev)", () => {
  const repository = new PrismaScheduleRepository();

  async function cleanup(): Promise<void> {
    const prisma = getPrismaClient();
    const rows = await prisma.schedule.findMany({ where: { courseId: { startsWith: PREFIX } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    await prisma.scheduleSlot.deleteMany({ where: { scheduleId: { in: ids } } });
    await prisma.slotCounter.deleteMany({ where: { scheduleId: { in: ids } } });
    await prisma.schedule.deleteMany({ where: { id: { in: ids } } });
  }

  before(async () => {
    assertStage13Target();
    await cleanup();
  });

  after(async () => {
    await cleanup().catch(() => undefined);
    await disconnectPrisma();
  });

  it("insert persists schedule + slot + counter seed atomically and reads back in the legacy wire shape", async () => {
    await repository.insertSchedule(newSchedule());
    const [record] = await repository.findByDateAndCourse("2026-10-05", COURSE_A);
    assert.match(String(record._id), /^[0-9a-f]{24}$/);
    assert.deepEqual(
      { ...record, _id: undefined },
      {
        _id: undefined,
        courseId: COURSE_A,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        name: "Stage 15 IELTS",
        testSystem: "",
        testType: "Computer-Based",
        status: "Scheduled",
        timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 12, slotId: "1" }],
        createdAt: new Date("2026-10-01T02:03:04.567Z"),
      }
    );
    const prisma = getPrismaClient();
    const slots = await prisma.scheduleSlot.findMany({ where: { scheduleId: String(record._id) } });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].position, 0);
    const counter = await prisma.slotCounter.findUnique({ where: { scheduleId: String(record._id) } });
    assert.equal(counter?.nextN, 2);
  });

  it("findMaxSlotId: key-scoped, numeric, ignores non-numeric slot ids, 0 when nothing matches", async () => {
    const key = { courseId: COURSE_A, startDate: "2026-10-05", endDate: "2026-10-05", testType: "Computer-Based" as const };
    assert.equal(await repository.findMaxSlotId(key), 1);
    await repository.insertSchedule(newSchedule({ timeSlots: [{ startTime: "11:00:00", endTime: "12:00:00", slot: 1, totalSlot: 1, slotId: "10" }] }));
    await repository.insertSchedule(newSchedule({ timeSlots: [{ startTime: "11:00:00", endTime: "12:00:00", slot: 1, totalSlot: 1, slotId: "2" }] }));
    // numeric (10 > 2), not lexical
    assert.equal(await repository.findMaxSlotId(key), 10);
    assert.equal(await repository.findMaxSlotId({ ...key, testType: "Paper-Based" }), 0);
    assert.equal(await repository.findMaxSlotId({ ...key, courseId: COURSE_MISSING }), 0);
    assert.equal(await repository.findMaxSlotId({ ...key, startDate: "2026-10-06", endDate: "2026-10-06" }), 0);

    // A legacy non-numeric slot id must not poison the allocator.
    const prisma = getPrismaClient();
    const odd = await prisma.schedule.findFirstOrThrow({ where: { courseId: COURSE_A } });
    await prisma.scheduleSlot.create({
      data: { scheduleId: odd.id, position: 9, slotId: "abc", seatsLeft: 0, capacityTotal: 0, startTime: "00:00:00", endTime: "00:00:00" },
    });
    assert.equal(await repository.findMaxSlotId(key), 10);
  });

  it("daily read orders by first-slot number numerically ('2' before '10' before text), excludes Cancelled, ignores other days/courses", async () => {
    await repository.insertSchedule(newSchedule({ status: "Cancelled", timeSlots: [{ startTime: "13:00:00", endTime: "14:00:00", slot: 1, totalSlot: 1, slotId: "99" }] }));
    await repository.insertSchedule(newSchedule({ startDate: "2026-10-06", endDate: "2026-10-06" }));
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B }));
    const records = await repository.findByDateAndCourse("2026-10-05", COURSE_A);
    const firstSlotIds = records.map((r) => (r.timeSlots as Array<{ slotId: string }>)[0].slotId);
    assert.deepEqual(firstSlotIds, ["1", "2", "10"]);
    assert.ok(records.every((r) => r.status === "Scheduled"));
  });

  it("daily read: non-canonical inputs match nothing instead of erroring", async () => {
    assert.deepEqual(await repository.findByDateAndCourse("2026-10-05", "c1"), []);
    assert.deepEqual(await repository.findByDateAndCourse("not-a-date", COURSE_A), []);
    assert.deepEqual(await repository.findByDateAndCourse("2026-02-31", COURSE_A), []);
    assert.deepEqual(await repository.findByDateAndCourse("2026-10-05", COURSE_MISSING), []);
  });

  it("daily read accepts a mixed-case course id (canonicalized)", async () => {
    const records = await repository.findByDateAndCourse("2026-10-05", COURSE_A.toUpperCase());
    assert.ok(records.length >= 3);
  });

  it("monthly read: start inclusive / end exclusive string boundaries, Cancelled excluded, id-ordered", async () => {
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-09-30", endDate: "2026-09-30" }));
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-10-01", endDate: "2026-10-01" }));
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-10-31", endDate: "2026-10-31" }));
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-11-01", endDate: "2026-11-01" }));
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-10-15", endDate: "2026-10-15", status: "Cancelled" }));
    const records = await repository.findByCourseAndMonth(COURSE_B, { startInclusive: "2026-10-01", endExclusive: "2026-11-01" });
    const dates = records.map((r) => r.startDate).sort();
    // COURSE_B also holds the "2026-10-05" row from the daily test.
    assert.deepEqual(dates, ["2026-10-01", "2026-10-05", "2026-10-31"]);
    const ids = records.map((r) => String(r._id));
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(await repository.findByCourseAndMonth("zzz", { startInclusive: "2026-10-01", endExclusive: "2026-11-01" }), []);
  });

  it("admin list: _id desc, skip/limit, filters, impossible filters match nothing, count agrees", async () => {
    const all = await repository.listAdmin({ courseId: COURSE_B }, { page: 1, limit: 100, skip: 0 });
    const ids = all.map((r) => String(r._id));
    assert.deepEqual(ids, [...ids].sort().reverse());
    assert.equal(await repository.countAdmin({ courseId: COURSE_B }), all.length);

    const paged = await repository.listAdmin({ courseId: COURSE_B }, { page: 2, limit: 2, skip: 2 });
    assert.deepEqual(paged.map((r) => String(r._id)), ids.slice(2, 4));

    const cancelled = await repository.listAdmin({ courseId: COURSE_B, status: "Cancelled" }, { page: 1, limit: 100, skip: 0 });
    assert.equal(cancelled.length, 1);
    assert.equal(await repository.countAdmin({ courseId: COURSE_B, status: "Cancelled" }), 1);

    assert.deepEqual(await repository.listAdmin({ status: "Draft" }, { page: 1, limit: 10, skip: 0 }), []);
    assert.equal(await repository.countAdmin({ status: "Draft" }), 0);
    assert.deepEqual(await repository.listAdmin({ courseId: "c1" }, { page: 1, limit: 10, skip: 0 }), []);
    assert.equal(await repository.countAdmin({ courseId: "c1" }), 0);
  });

  it("delete removes schedule + slots + counter together; missing/invalid ids return false", async () => {
    await repository.insertSchedule(newSchedule({ courseId: COURSE_B, startDate: "2026-12-01", endDate: "2026-12-01" }));
    const prisma = getPrismaClient();
    const row = await prisma.schedule.findFirstOrThrow({ where: { courseId: COURSE_B, startDate: new Date("2026-12-01T00:00:00.000Z") } });
    assert.equal(await repository.deleteById(row.id), true);
    assert.equal(await prisma.schedule.count({ where: { id: row.id } }), 0);
    assert.equal(await prisma.scheduleSlot.count({ where: { scheduleId: row.id } }), 0);
    assert.equal(await prisma.slotCounter.count({ where: { scheduleId: row.id } }), 0);
    assert.equal(await repository.deleteById(row.id), false);
    assert.equal(await repository.deleteById(`${PREFIX}dddddddddddddddd`), false);
    assert.equal(await repository.deleteById("not-an-id"), false);
  });

  it("an insert that violates a constraint leaves no partial rows (single transaction)", async () => {
    const before = await getPrismaClient().schedule.count({ where: { courseId: COURSE_A } });
    await assert.rejects(
      () =>
        repository.insertSchedule(
          // two slots with the same slot id violate uq_schedule_slots_schedule_id_slot_id
          newSchedule({
            timeSlots: [
              { startTime: "09:00:00", endTime: "10:00:00", slot: 1, totalSlot: 1, slotId: "77" },
              { startTime: "10:00:00", endTime: "11:00:00", slot: 1, totalSlot: 1, slotId: "77" },
            ],
          })
        ),
      (error: Error) => {
        assert.equal(error.name, "PersistenceError");
        assert.doesNotMatch(error.message, /uq_schedule|schedule_slots|Unique|constraint|Prisma/i);
        return true;
      }
    );
    assert.equal(await getPrismaClient().schedule.count({ where: { courseId: COURSE_A } }), before);
  });

  it("findByUserId is always empty: PostgreSQL has no schedule.userId", async () => {
    assert.deepEqual(await repository.findByUserId("507f1f77bcf86cd799439011"), []);
  });

  it("Stage 14 reconciled schedules are readable through the repository (no test prefix)", async () => {
    const all = await repository.listAdmin({}, { page: 1, limit: 500, skip: 0 });
    const real = all.filter((r) => !String(r.courseId).startsWith(PREFIX));
    assert.ok(real.length > 0);
    for (const record of real) {
      assert.match(String(record._id), /^[0-9a-f]{24}$/);
      assert.match(String(record.startDate), /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(["Computer-Based", "Paper-Based"].includes(String(record.testType)));
      assert.ok(Array.isArray(record.timeSlots));
    }
  });

  it("a fired statement timeout becomes a TIMEOUT PersistenceError, and the repository maps it to ScheduleQueryTimeoutError", async () => {
    await assert.rejects(
      () =>
        runPersistence({ table: "schedules", operation: "test.sleep" }, () =>
          runWithStatementTimeout(getPrismaClient(), 50, (tx) => tx.$queryRawUnsafe("SELECT pg_sleep(2)"))
        ),
      (error: Error & { kind?: string }) => {
        assert.equal(error.name, "PersistenceError");
        assert.equal(error.kind, "TIMEOUT");
        assert.doesNotMatch(error.message, /pg_sleep|SELECT/i);
        return true;
      }
    );

    const sleepy = new PrismaScheduleRepository(
      () => {
        const client = getPrismaClient();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return (fn: (tx: unknown) => Promise<unknown>, options: unknown) =>
                target.$transaction(
                  async (tx) => {
                    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 50");
                    await tx.$queryRawUnsafe("SELECT pg_sleep(2)");
                    return fn(tx);
                  },
                  options as never
                );
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      },
      { listMs: 8000, countMs: 3000 }
    );
    await assert.rejects(() => sleepy.listAdmin({}, { page: 1, limit: 10, skip: 0 }), ScheduleQueryTimeoutError);
    await assert.rejects(() => sleepy.countAdmin({}), ScheduleQueryTimeoutError);
  });

  it("other Prisma failures are translated: no SQL, table, or Prisma class detail crosses the boundary", async () => {
    const failing = new PrismaScheduleRepository(() => {
      const client = getPrismaClient();
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "schedule") {
            return { findMany: () => client.$queryRaw`SELECT * FROM stage15_table_that_does_not_exist` };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
    await assert.rejects(
      () => failing.findByCourseAndMonth(COURSE_A, { startInclusive: "2026-10-01", endExclusive: "2026-11-01" }),
      (error: Error) => {
        assert.equal(error.name, "PersistenceError");
        assert.doesNotMatch(error.message, /SELECT|stage15_table|relation|Prisma/i);
        return true;
      }
    );
  });
});
