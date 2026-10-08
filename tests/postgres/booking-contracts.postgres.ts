import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { teacherAssignmentId } from "../../src/app/modules/booking/teacher-assignment.id";
import { assertStage13Target } from "./helpers/stage13-target";

// Stage 16 read-only live contracts on stage13-dev: foreign keys, the stored
// deterministic assignment ids, and the data anomalies the report lists.
// Nothing is written.

const report: Record<string, unknown> = {};

describe("Stage 16 live contracts (read-only, stage13-dev)", { timeout: 300_000 }, () => {
  assertStage13Target();
  const prisma = getPrismaClient();
  after(async () => {
    console.log("CONTRACT_REPORT " + JSON.stringify(report));
    await disconnectPrisma();
  });

  it("FK contract: only the existing Session/Account -> users authentication FKs exist; nothing blocks hard-delete cancellation", async () => {
    const rows = await prisma.$queryRaw<Array<{ child: string; parent: string; name: string; on_delete: string }>>`
      SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent, conname::text AS name, confdeltype::text AS on_delete
      FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 3`;
    report.foreignKeys = rows.map((r) => `${r.child}->${r.parent}`);
    const touching = rows.filter((r) => ["bookings", "teacher_assignments", "schedule_slots", "schedules", "mock_allocations"].some((t) => r.child === t || r.parent === t));
    assert.deepEqual(touching, [], "no FK may reference or originate from booking/seat/assignment tables");
    const outsideAllowed = rows.filter((r) => !((r.child === "sessions" || r.child === "accounts") && r.parent === "users"));
    assert.deepEqual(outsideAllowed, [], "only sessions/accounts -> users are allowed");
    for (const r of rows) assert.equal(r.on_delete, "c", `${r.name} is ON DELETE CASCADE (auth tables only)`);
  });

  it("every stored teacher_assignments id equals the runtime deterministic id (UUIDv5 over user + raw legacy key)", async () => {
    const rows = await prisma.teacherAssignment.findMany({ select: { id: true, userId: true, legacyKey: true } });
    const mismatched = rows.filter((r) => teacherAssignmentId(r.userId, r.legacyKey) !== r.id);
    report.teacherAssignmentRows = rows.length;
    report.teacherAssignmentIdMismatches = mismatched.length;
    assert.equal(mismatched.length, 0);
    const groups = new Map<string, number>();
    for (const r of rows) groups.set(`${r.userId}:${r.legacyKey.toLowerCase()}`, (groups.get(`${r.userId}:${r.legacyKey.toLowerCase()}`) ?? 0) + 1);
    report.duplicateAssignmentKeys = [...groups.values()].filter((n) => n > 1).length;
    assert.equal(report.duplicateAssignmentKeys, 0, "no case-insensitive duplicate (user, key) pairs");
  });

  it("anomaly census (informational, never repaired)", async () => {
    const one = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
    report.usersNegativeMock = await one(prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM users WHERE mock < 0`);
    report.slotsSeatsOutOfRange = await one(prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM schedule_slots WHERE seats_left < 0 OR seats_left > capacity_total`);
    report.slotsSeatDrift = await one(prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM schedule_slots s
      WHERE s.capacity_total - s.seats_left <> (SELECT COUNT(*) FROM bookings b WHERE b.schedule_id = s.schedule_id AND b.slot_id = s.slot_id)`);
    report.duplicateHomeUserDate = await one(prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM bookings WHERE location = 'Home'::"BookingLocation" GROUP BY user_id, booking_date HAVING COUNT(*) > 1) g`);
    report.duplicateCenterUserScheduleSlot = await one(prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM bookings WHERE location = 'Test Center'::"BookingLocation" GROUP BY user_id, schedule_id, slot_id HAVING COUNT(*) > 1) g`);
    report.bookingsWithoutUser = await one(prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id)`);
    report.testCenterBookingsWithoutSlot = await one(prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM bookings b WHERE b.location = 'Test Center'::"BookingLocation"
      AND NOT EXISTS (SELECT 1 FROM schedule_slots s WHERE s.schedule_id = b.schedule_id AND s.slot_id = b.slot_id)`);
    report.assignmentsWithoutBooking = await one(prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM teacher_assignments t WHERE t.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = t.booking_id)`);
    report.fixtureResidue = await one(prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM users WHERE id LIKE 'ffff5166%'`);
    assert.equal(report.fixtureResidue, 0);
  });
});
