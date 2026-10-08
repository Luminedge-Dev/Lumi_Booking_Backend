import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../src/generated/prisma/client.js";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { runSerializableTransaction } from "../../src/app/database/transaction";
import { PersistenceError } from "../../src/app/database/persistence-error";
import { newObjectIdHex } from "../../src/app/shared/utils/object-id";
import { BOOKING_TRANSACTION, PrismaBookingRepository } from "../../src/app/modules/booking/booking.repository";
import { teacherAssignmentId } from "../../src/app/modules/booking/teacher-assignment.id";
import type { HomeBookingCommand, TestCenterBookingCommand } from "../../src/app/modules/booking/booking.types";
import { assertStage13Target } from "./helpers/stage13-target";
import { Stage16Fixtures, stage16Id, STAGE16_EMAIL_DOMAIN } from "./helpers/stage16-fixtures";

// Stage 16 live PostgreSQL suite (stage13-dev only): the four permanent
// transaction invariants, real concurrency, rollback injection and timing.
// Every row created here is under the 0xffff5166 fixture namespace (or is a
// booking/assignment owned by a fixture user) and is removed in after().

const report: Record<string, unknown> = {};
const timings: Record<string, number[]> = {};
const now = () => Number(process.hrtime.bigint() / 1_000_000n);
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    (timings[label] ??= []).push(now() - start);
  }
}
function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

let counter = 5000;
const fresh = () => stage16Id(counter++);

describe("Stage 16 booking repository (live stage13-dev)", { timeout: 1_800_000 }, () => {
  assertStage13Target();
  const prisma = getPrismaClient();
  const fixtures = new Stage16Fixtures(prisma);
  const repository = new PrismaBookingRepository();

  after(async () => {
    try {
      report.timings = Object.fromEntries(
        Object.entries(timings).map(([label, values]) => [label, { n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: Math.max(...values) }])
      );
      report.transactionSettings = BOOKING_TRANSACTION;
      report.cleanupRemoved = await fixtures.cleanup();
      await fixtures.assertNamespaceEmpty("after cleanup");
      report.namespaceEmptyAfterCleanup = true;
    } finally {
      console.log("BOOKING_REPORT " + JSON.stringify(report));
      await disconnectPrisma();
    }
  });

  async function createUser(mock: number, extra: Record<string, unknown> = {}): Promise<string> {
    const id = fixtures.trackUser(fresh());
    await prisma.user.create({
      data: { id, name: "stage16-test-user", email: `${id}@${STAGE16_EMAIL_DOMAIN}`, password: "x", role: "user", mock, totalMock: mock, ...extra },
    });
    return id;
  }

  async function createSchedule(seats: number, startDate = "2031-02-03"): Promise<{ scheduleId: string; slotId: string }> {
    const scheduleId = fixtures.trackSchedule(fresh());
    await prisma.schedule.create({
      data: {
        id: scheduleId, name: "stage16-test", courseId: stage16Id(1), startDate: new Date(`${startDate}T00:00:00.000Z`),
        endDate: new Date(`${startDate}T00:00:00.000Z`), testType: "ComputerBased", status: "Scheduled", createdAt: new Date(),
      },
    });
    await prisma.scheduleSlot.create({
      data: { scheduleId, position: 0, slotId: "1", seatsLeft: seats, capacityTotal: seats, startTime: "09:00", endTime: "10:00" },
    });
    return { scheduleId, slotId: "1" };
  }

  const home = (userId: string, bookingDate: string, extra: Partial<HomeBookingCommand> = {}): HomeBookingCommand => ({
    bookingId: newObjectIdHex(), userId, name: "IELTS", testType: "Computer-Based", testSystem: "Computer-Based",
    bookingDate, testTime: "10:30", entitlement: null, ...extra,
  });
  const center = (userId: string, scheduleId: string, slotId: string, extra: Partial<TestCenterBookingCommand> = {}): TestCenterBookingCommand => ({
    bookingId: newObjectIdHex(), userId, scheduleId, slotId, name: "IELTS", testType: "Computer-Based", testSystem: null,
    bookingDate: "2031-02-03", startTime: "09:00", endTime: "10:00", entitlement: null, ...extra,
  });
  const mockOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mock;
  const seatsOf = async (scheduleId: string, slotId = "1") =>
    (await prisma.scheduleSlot.findFirstOrThrow({ where: { scheduleId, slotId } })).seatsLeft;
  const bookingCount = (where: Record<string, unknown>) => prisma.booking.count({ where });

  it("fixture namespace is empty before the run", async () => {
    await fixtures.assertNamespaceEmpty("before run");
  });

  it("invariant 1 — Home booking: credit decrement + insert commit together; duplicate and zero credit change nothing", async () => {
    const userId = await createUser(2);
    const first = await timed("home.book", () => repository.createHomeBooking(home(userId, "2031-03-01")));
    assert.equal(first.kind, "booked");
    if (first.kind === "booked") {
      assert.equal(first.booking.status, "pending");
      assert.equal(first.booking.location, "Home");
      assert.equal(first.booking.bookingDate, "2031-03-01");
    }
    assert.equal(await mockOf(userId), 1);
    assert.equal(await bookingCount({ userId }), 1);

    const dup = await repository.createHomeBooking(home(userId, "2031-03-01"));
    assert.equal(dup.kind, "duplicate");
    assert.equal(await mockOf(userId), 1);

    const second = await repository.createHomeBooking(home(userId, "2031-03-02"));
    assert.equal(second.kind, "booked");
    assert.equal(await mockOf(userId), 0);
    const none = await repository.createHomeBooking(home(userId, "2031-03-03"));
    assert.equal(none.kind, "insufficient_credit");
    assert.equal(await mockOf(userId), 0);
    assert.equal(await bookingCount({ userId }), 2);
  });

  it("invariant 2 — Test Center booking: seat + credit + insert commit together", async () => {
    const userId = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(5);
    const outcome = await timed("center.book", () => repository.createTestCenterBooking(center(userId, scheduleId, slotId)));
    assert.equal(outcome.kind, "booked");
    if (outcome.kind === "booked") assert.equal(outcome.booking.testSystem, null);
    assert.equal(await seatsOf(scheduleId), 4);
    assert.equal(await mockOf(userId), 0);
    assert.equal(await bookingCount({ userId, scheduleId }), 1);

    const dup = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    assert.equal(dup.kind, "insufficient_credit"); // credit gate precedes the duplicate probe
    assert.equal(await seatsOf(scheduleId), 4);
  });

  it("last-seat race: exactly one winner, no oversell, losers keep credit", async () => {
    const { scheduleId, slotId } = await createSchedule(1);
    const users = await Promise.all([1, 2, 3, 4].map(() => createUser(1)));
    const outcomes = await timed("race.last_seat", () => Promise.all(users.map((u) => repository.createTestCenterBooking(center(u, scheduleId, slotId)))));
    const booked = outcomes.filter((o) => o.kind === "booked");
    const taken = outcomes.filter((o) => o.kind === "slot_taken");
    assert.equal(booked.length, 1, JSON.stringify(outcomes.map((o) => o.kind)));
    assert.equal(taken.length, 3);
    assert.equal(await seatsOf(scheduleId), 0);
    assert.equal(await bookingCount({ scheduleId }), 1);
    const credits = await Promise.all(users.map(mockOf));
    assert.equal(credits.filter((c) => c === 0).length, 1);
    assert.equal(credits.filter((c) => c === 1).length, 3);
    report.lastSeatRace = outcomes.map((o) => o.kind);
  });

  it("same-user credit exhaustion: one credit, many concurrent Home bookings -> one booking, mock never negative", async () => {
    const userId = await createUser(1);
    const dates = ["2031-04-01", "2031-04-02", "2031-04-03", "2031-04-04"];
    const outcomes = await timed("race.credit", () => Promise.all(dates.map((d) => repository.createHomeBooking(home(userId, d)))));
    assert.equal(outcomes.filter((o) => o.kind === "booked").length, 1, JSON.stringify(outcomes.map((o) => o.kind)));
    assert.equal(outcomes.filter((o) => o.kind === "insufficient_credit").length, 3);
    assert.equal(await mockOf(userId), 0);
    assert.equal(await bookingCount({ userId }), 1);
    report.creditExhaustion = outcomes.map((o) => o.kind);
  });

  it("invariant 3 — cancellation: delete + seat restore + credit restore once; concurrent double cancel restores once", async () => {
    const userId = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(3);
    const booked = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    assert.equal(booked.kind, "booked");
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    assert.equal(await seatsOf(scheduleId), 2);
    assert.equal(await mockOf(userId), 0);

    const results = await timed("race.double_cancel", () =>
      Promise.all([1, 2, 3, 4].map(() => repository.cancelBooking({ bookingId, actorUserId: userId, actorIsAdmin: false })))
    );
    assert.equal(results.filter((r) => r.kind === "cancelled").length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.kind === "not_found").length, 3);
    assert.equal(await seatsOf(scheduleId), 3, "seat restored exactly once");
    assert.equal(await mockOf(userId), 1, "credit restored exactly once");
    assert.equal(await bookingCount({ userId }), 0);
    report.doubleCancel = results.map((r) => r.kind);
  });

  it("cancellation ownership: another user is forbidden and nothing changes; admin may cancel", async () => {
    const owner = await createUser(1);
    const stranger = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(2);
    const booked = await repository.createTestCenterBooking(center(owner, scheduleId, slotId));
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    const denied = await repository.cancelBooking({ bookingId, actorUserId: stranger, actorIsAdmin: false });
    assert.equal(denied.kind, "forbidden");
    assert.equal(await seatsOf(scheduleId), 1);
    assert.equal(await mockOf(owner), 0);
    const admin = await timed("cancel.single", () => repository.cancelBooking({ bookingId, actorUserId: stranger, actorIsAdmin: true }));
    assert.equal(admin.kind, "cancelled");
    assert.equal(await seatsOf(scheduleId), 2);
    assert.equal(await mockOf(owner), 1);
  });

  it("cancel tolerates a deleted schedule slot (legacy parity): booking removed, credit restored, no seat row", async () => {
    const userId = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(2);
    const booked = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    await prisma.scheduleSlot.deleteMany({ where: { scheduleId } });
    const result = await repository.cancelBooking({ bookingId, actorUserId: userId, actorIsAdmin: false });
    assert.equal(result.kind, "cancelled");
    assert.equal(await mockOf(userId), 1);
    assert.equal(await bookingCount({ userId }), 0);
  });

  it("cancel racing a new booking on the same slot: no deadlock, invariants hold (lock order users -> slot -> booking)", async () => {
    const { scheduleId, slotId } = await createSchedule(1);
    const a = await createUser(1);
    const b = await createUser(1);
    const first = await repository.createTestCenterBooking(center(a, scheduleId, slotId));
    const aBooking = first.kind === "booked" ? first.booking._id : "";
    assert.equal(await seatsOf(scheduleId), 0);

    const settled = await Promise.allSettled([
      repository.cancelBooking({ bookingId: aBooking, actorUserId: a, actorIsAdmin: false }),
      repository.createTestCenterBooking(center(b, scheduleId, slotId)),
      repository.createTestCenterBooking(center(a, scheduleId, slotId)),
    ]);
    for (const s of settled) assert.equal(s.status, "fulfilled", s.status === "rejected" ? String((s.reason as Error)?.message) : "");
    const seats = await seatsOf(scheduleId);
    const remaining = await bookingCount({ scheduleId });
    assert.equal(seats + remaining, 1, "capacity conservation: seats_left + bookings == capacity");
    assert.ok(seats >= 0 && seats <= 1);
    assert.equal((await mockOf(a)) + (await bookingCount({ userId: a })), 1, "user a credit + bookings conserved");
    assert.equal((await mockOf(b)) + (await bookingCount({ userId: b })), 1, "user b credit + bookings conserved");
    report.cancelVsBook = settled.map((s) => (s.status === "fulfilled" ? (s.value as { kind: string }).kind : "rejected"));
  });

  it("rollback injection: a failure after any step leaves seats, credit and bookings untouched", async () => {
    const userId = await createUser(2);
    const { scheduleId, slotId } = await createSchedule(3);
    for (const point of ["test_center.after_seat", "test_center.after_credit", "test_center.after_insert"]) {
      const faulty = new PrismaBookingRepository(undefined, undefined, (p) => {
        if (p === point) throw new Error(`injected failure at ${p}`);
      });
      await assert.rejects(() => faulty.createTestCenterBooking(center(userId, scheduleId, slotId)), new RegExp(point));
      assert.equal(await seatsOf(scheduleId), 3, `seat unchanged after ${point}`);
      assert.equal(await mockOf(userId), 2, `credit unchanged after ${point}`);
      assert.equal(await bookingCount({ userId }), 0, `no booking after ${point}`);
    }
    for (const point of ["home.after_credit", "home.after_insert"]) {
      const faulty = new PrismaBookingRepository(undefined, undefined, (p) => {
        if (p === point) throw new Error(`injected failure at ${p}`);
      });
      await assert.rejects(() => faulty.createHomeBooking(home(userId, "2031-05-01")), new RegExp(point));
      assert.equal(await mockOf(userId), 2);
      assert.equal(await bookingCount({ userId }), 0);
    }

    const ok = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    const bookingId = ok.kind === "booked" ? ok.booking._id : "";
    for (const point of ["cancel.after_delete", "cancel.after_seat_restore"]) {
      const faulty = new PrismaBookingRepository(undefined, undefined, (p) => {
        if (p === point) throw new Error(`injected failure at ${p}`);
      });
      await assert.rejects(() => faulty.cancelBooking({ bookingId, actorUserId: userId, actorIsAdmin: false }), new RegExp(point));
      assert.equal(await bookingCount({ userId }), 1, `booking survives failure at ${point}`);
      assert.equal(await seatsOf(scheduleId), 2, `seat not restored after ${point}`);
      assert.equal(await mockOf(userId), 1, `credit not restored after ${point}`);
    }
  });

  it("cancel with a missing user row rolls back everything (credit restore must affect one row)", async () => {
    const userId = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(2);
    const booked = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    // Orphan the booking: remove the user row, keep the booking row.
    await prisma.user.delete({ where: { id: userId } });
    const result = await repository.cancelBooking({ bookingId, actorUserId: userId, actorIsAdmin: false });
    assert.equal(result.kind, "credit_restore_failed");
    assert.equal(await bookingCount({ id: bookingId }), 1, "booking delete rolled back");
    assert.equal(await seatsOf(scheduleId), 1, "seat restore rolled back");
  });

  it("serialization conflict: a real-shaped P2034 is retried inside the helper and commits once", async () => {
    const userId = await createUser(1);
    let attempts = 0;
    const flaky = new PrismaBookingRepository(undefined, undefined, (point) => {
      if (point === "home.after_insert") {
        attempts += 1;
        if (attempts === 1) throw new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
      }
    });
    const outcome = await flaky.createHomeBooking(home(userId, "2031-06-01"));
    assert.equal(outcome.kind, "booked");
    assert.equal(attempts, 2);
    assert.equal(await mockOf(userId), 0, "credit decremented exactly once");
    assert.equal(await bookingCount({ userId }), 1);
  });

  it("serialization conflict: exhausted retries surface as PersistenceError.conflict and change nothing", async () => {
    const userId = await createUser(1);
    const { scheduleId, slotId } = await createSchedule(2);
    const always = new PrismaBookingRepository(
      undefined,
      (fn, options) => runSerializableTransaction(fn, { ...options, maxAttempts: 2, backoffMs: 5 }),
      (point) => {
        if (point === "test_center.after_credit") throw new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
      }
    );
    const error = await always.createTestCenterBooking(center(userId, scheduleId, slotId)).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof PersistenceError);
    assert.equal((error as PersistenceError).conflict, true);
    assert.equal(await seatsOf(scheduleId), 2);
    assert.equal(await mockOf(userId), 1);
  });

  it("invariant 4 — teacher assignment: authoritative row + booking cache in one transaction; deterministic id; idempotent", async () => {
    const userId = await createUser(2);
    const booked = await repository.createHomeBooking(home(userId, "2031-07-01"));
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";

    const assigned = await timed("teacher.assign", () => repository.assignTeacher({ bookingId, skill: "L", teacher: "Ms Lee", email: "lee@example.test" }));
    assert.equal(assigned.kind, "assigned");
    if (assigned.kind === "assigned") {
      assert.equal(assigned.booking.teacherL, "Ms Lee");
      assert.equal(assigned.booking.teacherLEmail, "lee@example.test");
    }
    const id = teacherAssignmentId(userId, bookingId);
    const row = await prisma.teacherAssignment.findUniqueOrThrow({ where: { id } });
    assert.equal(row.teacherL, "Ms Lee");
    assert.equal(row.bookingId, bookingId);

    await repository.assignTeacher({ bookingId, skill: "L", teacher: "Mr Kim", email: "kim@example.test" });
    assert.equal(await prisma.teacherAssignment.count({ where: { userId } }), 1, "no duplicate assignment row");
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    assert.equal(booking.teacherL, "Mr Kim");
    assert.equal((await prisma.teacherAssignment.findUniqueOrThrow({ where: { id } })).teacherL, "Mr Kim");
  });

  it("teacher assignment: concurrent different skills both persist; non-Home booking is not found; rollback leaves both stores unchanged", async () => {
    const userId = await createUser(2);
    const booked = await repository.createHomeBooking(home(userId, "2031-07-02"));
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    const results = await timed("race.teacher", () =>
      Promise.all([
        repository.assignTeacher({ bookingId, skill: "L", teacher: "T-L", email: "l@example.test" }),
        repository.assignTeacher({ bookingId, skill: "R", teacher: "T-R", email: "r@example.test" }),
        repository.assignTeacher({ bookingId, skill: "W", teacher: "T-W", email: "w@example.test" }),
      ])
    );
    assert.deepEqual(results.map((r) => r.kind), ["assigned", "assigned", "assigned"]);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const row = await prisma.teacherAssignment.findUniqueOrThrow({ where: { id: teacherAssignmentId(userId, bookingId) } });
    assert.deepEqual([booking.teacherL, booking.teacherR, booking.teacherW], ["T-L", "T-R", "T-W"]);
    assert.deepEqual([row.teacherL, row.teacherR, row.teacherW], ["T-L", "T-R", "T-W"], "cache and authoritative row agree");
    assert.equal(await prisma.teacherAssignment.count({ where: { userId } }), 1);

    const { scheduleId, slotId } = await createSchedule(2);
    const center1 = await repository.createTestCenterBooking(center(userId, scheduleId, slotId));
    const centerId = center1.kind === "booked" ? center1.booking._id : "";
    assert.equal((await repository.assignTeacher({ bookingId: centerId, skill: "L", teacher: "x", email: "x@example.test" })).kind, "not_found");

    const faulty = new PrismaBookingRepository(undefined, undefined, (p) => {
      if (p === "teacher.after_assignment") throw new Error("injected failure at teacher.after_assignment");
    });
    await assert.rejects(() => faulty.assignTeacher({ bookingId, skill: "S", teacher: "T-S", email: "s@example.test" }), /teacher\.after_assignment/);
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const rowAfter = await prisma.teacherAssignment.findUniqueOrThrow({ where: { id: teacherAssignmentId(userId, bookingId) } });
    assert.equal(after.teacherS, null);
    assert.equal(rowAfter.teacherS, null);
  });

  it("reads: by-user, admin list/count, by-schedule, home-with-users, attendance counts and update", async () => {
    const userId = await createUser(3);
    const { scheduleId, slotId } = await createSchedule(2, "2031-08-05");
    await repository.createHomeBooking(home(userId, "2031-08-01"));
    await repository.createTestCenterBooking(center(userId, scheduleId, slotId, { bookingDate: "2031-08-05" }));

    const mine = await repository.listByUser(userId);
    assert.equal(mine.length, 2);
    assert.equal(mine[0]!.bookingDate, "2031-08-05", "sorted by bookingDate desc");
    assert.ok(!("teacherL" in mine[0]!), "projection hides teacher fields");

    const bySchedule = await repository.listBySchedule(scheduleId, { skip: 0, limit: 10 });
    assert.equal(bySchedule.length, 1);
    assert.ok(!("location" in bySchedule[0]!), "by-schedule projection omits location");

    assert.ok((await repository.countAdmin({ location: "Home" })) >= 1);
    assert.equal((await repository.listAdmin({ location: "Nowhere" }, { skip: 0, limit: 5 })).length, 0);

    const homeUsers = await repository.listHomeWithUsers();
    const mineHome = homeUsers.find((b) => b.userId === userId);
    assert.ok(mineHome);
    assert.equal(mineHome!.user.mock, 1);
    assert.equal((mineHome!.user as Record<string, unknown>).password, undefined);

    assert.equal((await repository.updateAttendance({ kind: "home", userId, bookingDate: "2031-08-01" }, { status: "Present", attendance: "present" })).kind, "updated");
    assert.equal((await repository.updateAttendance({ kind: "home", userId, bookingDate: "2031-08-01" }, { status: "Present", attendance: "present" })).kind, "unchanged");
    assert.equal((await repository.updateAttendance({ kind: "home", userId, bookingDate: "2031-09-09" }, { status: "Present", attendance: "present" })).kind, "not_found");
    assert.equal((await repository.attendanceCounts([userId]))[userId], 1);
  });

  it("Home eligibility lookup and entitlement usage are case-insensitive / trimmed like the legacy rules", async () => {
    const userId = await createUser(3);
    await prisma.mockAllocation.create({ data: { userId, mock: 2, mockType: " ielts ", testType: "computer-based" } });
    const usage = await repository.entitlementUsage(userId, { mockType: "IELTS", testType: "Computer-Based" });
    assert.deepEqual(usage, { purchased: 2, used: 0 });
    await repository.createHomeBooking(home(userId, "2031-09-01", { name: "IELTS" }));
    assert.deepEqual(await repository.entitlementUsage(userId, { mockType: "IELTS", testType: "Computer-Based" }), { purchased: 2, used: 1 });
    // Entitlement exhaustion is enforced inside the transaction.
    await repository.createHomeBooking(home(userId, "2031-09-02", { name: "IELTS" }));
    const blocked = await repository.createHomeBooking(home(userId, "2031-09-03", { name: "IELTS", entitlement: { mockType: "IELTS", testType: "Computer-Based" } }));
    assert.equal(blocked.kind, "insufficient_credit");
    assert.equal(await mockOf(userId), 1, "blocked booking did not consume credit");
  });
});
