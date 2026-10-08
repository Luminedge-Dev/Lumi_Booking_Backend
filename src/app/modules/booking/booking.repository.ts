import type { Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { isStatementTimeout, PersistenceError, runPersistence } from "../../database/persistence-error";
import { runSerializableTransaction, runWithStatementTimeout, type TransactionClient } from "../../database/transaction";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import {
  LOCATION_FROM_WIRE,
  TEST_TYPE_FROM_WIRE,
  dateOnly,
  parseDateOnly,
  toBookedRecord,
  toBookingRecord,
  toProjectedRecord,
  type BookingRow,
} from "./booking.mapper";
import { teacherAssignmentId } from "./teacher-assignment.id";
import {
  BookingQueryTimeoutError,
  type AdminListFilter,
  type AssignTeacherCommand,
  type AssignTeacherOutcome,
  type AttendanceOutcome,
  type AttendanceTarget,
  type BookOutcome,
  type BookingExistingRef,
  type BookingRecord,
  type BookingStatusWire,
  type BookingUserContext,
  type CancelCommand,
  type CancelOutcome,
  type EntitlementPolicy,
  type HomeBookingCommand,
  type HomeBookingWithUser,
  type ScheduleSlotContext,
  type TestCenterBookingCommand,
} from "./booking.types";

// Persistence port. The service depends on this interface only; this file and
// teacher-assignment.repository.ts are the only booking files that touch Prisma.
export interface BookingRepository {
  findUserContext(userId: string): Promise<BookingUserContext | null>;
  entitlementUsage(userId: string, policy: EntitlementPolicy): Promise<{ purchased: number; used: number }>;
  findHomeSystems(courseName: string): Promise<string[] | null>;
  findScheduleSlot(scheduleId: string, slotId: string): Promise<ScheduleSlotContext | null>;
  createHomeBooking(command: HomeBookingCommand): Promise<BookOutcome>;
  createTestCenterBooking(command: TestCenterBookingCommand): Promise<BookOutcome>;
  findBookingRef(bookingId: string): Promise<BookingExistingRef | null>;
  cancelBooking(command: CancelCommand): Promise<CancelOutcome>;
  assignTeacher(command: AssignTeacherCommand): Promise<AssignTeacherOutcome>;
  listByUser(userId: string): Promise<Array<Partial<BookingRecord>>>;
  listAdmin(filter: AdminListFilter, params: { skip: number; limit: number }): Promise<Array<Partial<BookingRecord>>>;
  countAdmin(filter: AdminListFilter): Promise<number>;
  listBySchedule(scheduleId: string, params: { skip: number; limit: number }): Promise<Array<Partial<BookingRecord>>>;
  listHomeWithUsers(): Promise<HomeBookingWithUser[]>;
  attendanceCounts(userIds: string[]): Promise<Record<string, number>>;
  updateAttendance(target: AttendanceTarget, values: { status: BookingStatusWire; attendance: string }): Promise<AttendanceOutcome>;
}

// Transaction budget, chosen from live stage13-dev measurements (Step 0):
// a Test Center transaction runs ~2.3 s solo (p95 2.35 s), and 6 contenders
// finish within ~5.2 s including retries. 10 s to start / 15 s to finish keeps
// roughly 3x headroom without weakening atomicity.
export const BOOKING_TRANSACTION = { maxAttempts: 5, backoffMs: 25, maxWaitMs: 10000, timeoutMs: 15000 } as const;

type RunTransaction = typeof runSerializableTransaction;

// Signals a rollback with a defined outcome; thrown inside the transaction body.
class RollbackWith<T> extends Error {
  constructor(readonly outcome: T) {
    super("rollback");
    this.name = "RollbackWith";
  }
}

// Invariant that must roll back everything (a guard that cannot miss under
// the row locks did miss). Surfaces as the legacy generic 500.
export class BookingInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingInvariantError";
  }
}

export type BookingFaultHook = (point: string) => void | Promise<void>;

const lower = (value: string): string => value.trim().toLowerCase();

async function readEntitlementUsage(
  client: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  policy: EntitlementPolicy
): Promise<{ purchased: number; used: number }> {
  const rows = await client.$queryRaw<Array<{ purchased: number; used: number }>>`
    SELECT
      COALESCE((SELECT SUM(COALESCE(mock, 0)) FROM mock_allocations
        WHERE user_id = ${userId}
          AND lower(btrim(COALESCE(mock_type, ''))) = ${lower(policy.mockType)}
          AND lower(btrim(COALESCE(test_type, ''))) = ${lower(policy.testType)}), 0)::int AS purchased,
      (SELECT COUNT(*) FROM bookings
        WHERE user_id = ${userId} AND name = ${policy.mockType} AND test_type::text = ${policy.testType})::int AS used`;
  return { purchased: Number(rows[0]?.purchased ?? 0), used: Number(rows[0]?.used ?? 0) };
}

export class PrismaBookingRepository implements BookingRepository {
  constructor(
    private readonly getClient: () => PrismaClient = getPrismaClient,
    private readonly runTransaction: RunTransaction = runSerializableTransaction,
    private readonly fault: BookingFaultHook | undefined = undefined
  ) {}

  private async hit(point: string): Promise<void> {
    if (this.fault) await this.fault(point);
  }

  private transact<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.runTransaction(fn, BOOKING_TRANSACTION);
  }

  // ---- unlocked reads used to build commands --------------------------------

  async findUserContext(userId: string): Promise<BookingUserContext | null> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return null;
    return runPersistence({ table: "users", operation: "booking.find_user_context" }, async () => {
      const row = await this.getClient().user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, mock: true, mockType: true, testType: true },
      });
      return row ? { id: row.id, name: row.name, email: row.email, mock: row.mock, mockType: row.mockType, testType: row.testType } : null;
    });
  }

  async entitlementUsage(userId: string, policy: EntitlementPolicy): Promise<{ purchased: number; used: number }> {
    return runPersistence({ table: "mock_allocations", operation: "booking.entitlement_usage" }, () =>
      readEntitlementUsage(this.getClient(), userId, policy)
    );
  }

  async findHomeSystems(courseName: string): Promise<string[] | null> {
    return runPersistence({ table: "courses", operation: "booking.find_home_systems" }, async () => {
      const rows = await this.getClient().$queryRaw<Array<{ home_based_systems: string[] }>>`
        SELECT home_based_systems FROM courses WHERE lower(name) = lower(${courseName}) ORDER BY id ASC LIMIT 1`;
      return rows[0] ? rows[0].home_based_systems : null;
    });
  }

  async findScheduleSlot(scheduleId: string, slotId: string): Promise<ScheduleSlotContext | null> {
    const id = toCanonicalObjectIdHex(scheduleId);
    if (!id) return null;
    return runPersistence({ table: "schedules", operation: "booking.find_schedule_slot" }, async () => {
      const client = this.getClient();
      const schedule = await client.schedule.findUnique({ where: { id }, select: { id: true, startDate: true } });
      if (!schedule) return null;
      const slot = await client.scheduleSlot.findFirst({ where: { scheduleId: id, slotId } });
      return {
        scheduleId: id,
        startDate: dateOnly(schedule.startDate),
        slot: slot ? { slotId: slot.slotId, seatsLeft: slot.seatsLeft, startTime: slot.startTime, endTime: slot.endTime } : null,
      };
    });
  }

  async findBookingRef(bookingId: string): Promise<BookingExistingRef | null> {
    const id = toCanonicalObjectIdHex(bookingId);
    if (!id) return null;
    return runPersistence({ table: "bookings", operation: "booking.find_ref" }, async () => {
      const row = await this.getClient().booking.findUnique({ where: { id }, select: { id: true, userId: true, location: true } });
      return row ? { id: row.id, userId: row.userId, location: row.location === "Home" ? "Home" : "Test Center" } : null;
    });
  }

  // ---- invariant 1: Home booking --------------------------------------------
  // Lock order: users. Credit decrement and booking insert commit together.

  async createHomeBooking(command: HomeBookingCommand): Promise<BookOutcome> {
    return runPersistence({ table: "bookings", operation: "booking.create_home" }, () =>
      this.transact(async (tx): Promise<BookOutcome> => {
        const user = await tx.$queryRaw<Array<{ mock: number }>>`SELECT mock FROM users WHERE id = ${command.userId} FOR UPDATE`;
        if (!user[0] || user[0].mock <= 0) return { kind: "insufficient_credit" };

        if (command.entitlement) {
          const { purchased, used } = await readEntitlementUsage(tx, command.userId, command.entitlement);
          if (purchased > 0 && used >= purchased) return { kind: "insufficient_credit" };
        }

        // Same user lock serializes this check against every other booking of
        // the user; it mirrors the legacy pre-check, it is not a constraint.
        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM bookings WHERE user_id = ${command.userId} AND location = 'Home'::"BookingLocation" AND booking_date = ${command.bookingDate}::date LIMIT 1`;
        if (existing.length > 0) return { kind: "duplicate" };

        const credit = await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${command.userId} AND mock > 0`;
        if (credit !== 1) return { kind: "insufficient_credit" };
        await this.hit("home.after_credit");

        await tx.booking.create({
          data: {
            id: command.bookingId,
            userId: command.userId,
            name: command.name,
            location: "Home",
            bookingDate: parseDateOnly(command.bookingDate),
            status: "pending",
            testType: TEST_TYPE_FROM_WIRE[command.testType],
            testSystem: command.testSystem,
            testTime: command.testTime,
          },
        });
        await this.hit("home.after_insert");

        return {
          kind: "booked",
          booking: toBookedRecord({
            id: command.bookingId,
            userId: command.userId,
            name: command.name,
            location: "Home",
            bookingDate: command.bookingDate,
            testType: command.testType,
            testSystem: command.testSystem,
            testTime: command.testTime,
          }),
        };
      })
    );
  }

  // ---- invariant 2: Test Center booking -------------------------------------
  // Lock order: users -> schedule_slots (the guarded UPDATE takes the row lock).

  async createTestCenterBooking(command: TestCenterBookingCommand): Promise<BookOutcome> {
    return runPersistence({ table: "bookings", operation: "booking.create_test_center" }, () =>
      this.transact(async (tx): Promise<BookOutcome> => {
        const user = await tx.$queryRaw<Array<{ mock: number }>>`SELECT mock FROM users WHERE id = ${command.userId} FOR UPDATE`;
        if (!user[0] || user[0].mock <= 0) return { kind: "insufficient_credit" };

        if (command.entitlement) {
          const { purchased, used } = await readEntitlementUsage(tx, command.userId, command.entitlement);
          if (purchased > 0 && used >= purchased) return { kind: "insufficient_credit" };
        }

        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM bookings
          WHERE user_id = ${command.userId} AND schedule_id = ${command.scheduleId}
            AND booking_date = ${command.bookingDate}::date AND slot_id = ${command.slotId} LIMIT 1`;
        if (existing.length > 0) return { kind: "duplicate" };

        const seat = await tx.$executeRaw`
          UPDATE schedule_slots SET seats_left = seats_left - 1
          WHERE schedule_id = ${command.scheduleId} AND slot_id = ${command.slotId} AND seats_left > 0`;
        if (seat !== 1) return { kind: "slot_taken" };
        await this.hit("test_center.after_seat");

        const credit = await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${command.userId} AND mock > 0`;
        // Cannot miss while the user row is locked; if it ever does, the seat
        // decrement above must roll back (Stage 10 mandatory invariant).
        if (credit !== 1) throw new BookingInvariantError("credit decrement missed after seat decrement");
        await this.hit("test_center.after_credit");

        await tx.booking.create({
          data: {
            id: command.bookingId,
            userId: command.userId,
            scheduleId: command.scheduleId,
            slotId: command.slotId,
            name: command.name,
            location: "TestCenter",
            bookingDate: parseDateOnly(command.bookingDate),
            status: "pending",
            testType: TEST_TYPE_FROM_WIRE[command.testType],
            testSystem: command.testSystem,
            startTime: command.startTime,
            endTime: command.endTime,
          },
        });
        await this.hit("test_center.after_insert");

        return {
          kind: "booked",
          booking: toBookedRecord({
            id: command.bookingId,
            userId: command.userId,
            scheduleId: command.scheduleId,
            slotId: command.slotId,
            name: command.name,
            location: "Test Center",
            bookingDate: command.bookingDate,
            testType: command.testType,
            testSystem: command.testSystem,
            startTime: command.startTime,
            endTime: command.endTime,
          }),
        };
      })
    );
  }

  // ---- invariant 3: cancellation ---------------------------------------------
  // Canonical lock order: users -> schedule_slots -> bookings. The booking is
  // read unlocked first (to learn the lock set), then locked and revalidated.
  // Restores run only after the DELETE removed exactly one row, so a second
  // concurrent cancel finds no row and restores nothing.

  async cancelBooking(command: CancelCommand): Promise<CancelOutcome> {
    const bookingId = toCanonicalObjectIdHex(command.bookingId);
    if (!bookingId) return { kind: "not_found" };
    try {
      return await runPersistence({ table: "bookings", operation: "booking.cancel" }, async () => {
        const first = await this.getClient().booking.findUnique({
          where: { id: bookingId },
          select: { userId: true, scheduleId: true, slotId: true, location: true },
        });
        if (!first) return { kind: "not_found" } as CancelOutcome;

        return this.transact(async (tx): Promise<CancelOutcome> => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${first.userId} FOR UPDATE`;
          if (first.scheduleId && first.slotId) {
            await tx.$queryRaw`SELECT 1 AS x FROM schedule_slots WHERE schedule_id = ${first.scheduleId} AND slot_id = ${first.slotId} FOR UPDATE`;
          }
          const locked = await tx.$queryRaw<Array<{ user_id: string; schedule_id: string | null; slot_id: string | null; is_test_center: boolean }>>`
            SELECT user_id, schedule_id, slot_id, (location = 'Test Center'::"BookingLocation") AS is_test_center
            FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
          const row = locked[0];
          if (!row) return { kind: "not_found" };
          if (!command.actorIsAdmin && row.user_id !== command.actorUserId) return { kind: "forbidden" };
          if (row.user_id !== first.userId || row.schedule_id !== first.scheduleId || row.slot_id !== first.slotId) {
            throw new BookingInvariantError("booking references changed between the unlocked read and the row lock");
          }

          const deleted = await tx.$executeRaw`DELETE FROM bookings WHERE id = ${bookingId}`;
          if (deleted !== 1) return { kind: "not_found" };
          await this.hit("cancel.after_delete");

          if (row.is_test_center && row.schedule_id && row.slot_id) {
            // Unguarded by design (legacy parity): zero rows is a deleted schedule.
            await tx.$executeRaw`UPDATE schedule_slots SET seats_left = seats_left + 1 WHERE schedule_id = ${row.schedule_id} AND slot_id = ${row.slot_id}`;
          }
          await this.hit("cancel.after_seat_restore");

          const credit = await tx.$executeRaw`UPDATE users SET mock = mock + 1 WHERE id = ${row.user_id}`;
          if (credit !== 1) throw new RollbackWith<CancelOutcome>({ kind: "credit_restore_failed" });
          return { kind: "cancelled" };
        });
      });
    } catch (error) {
      if (error instanceof RollbackWith) return error.outcome as CancelOutcome;
      throw error;
    }
  }

  // ---- invariant 4: Home teacher assignment ------------------------------------
  // Authoritative state: teacher_assignments row keyed by the Stage 14
  // deterministic id. Compatibility state: bookings.teacher* columns. One
  // transaction; the bookings row lock serializes assignments per booking.

  async assignTeacher(command: AssignTeacherCommand): Promise<AssignTeacherOutcome> {
    const bookingId = toCanonicalObjectIdHex(command.bookingId);
    if (!bookingId) return { kind: "not_found" };
    return runPersistence({ table: "teacher_assignments", operation: "booking.assign_teacher" }, async () => {
      const first = await this.getClient().booking.findFirst({ where: { id: bookingId, location: "Home" }, select: { userId: true } });
      if (!first) return { kind: "not_found" } as AssignTeacherOutcome;

      return this.transact(async (tx): Promise<AssignTeacherOutcome> => {
        // A missing user row is a no-op, exactly like the legacy user-map write.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${first.userId} FOR UPDATE`;
        const locked = await tx.$queryRaw<Array<{ user_id: string }>>`
          SELECT user_id FROM bookings WHERE id = ${bookingId} AND location = 'Home'::"BookingLocation" FOR UPDATE`;
        if (!locked[0]) return { kind: "not_found" };
        const userId = locked[0].user_id;

        const assignmentId = teacherAssignmentId(userId, bookingId);
        const clash = await tx.teacherAssignment.findFirst({
          where: { userId, legacyKey: { equals: bookingId, mode: "insensitive" }, NOT: { id: assignmentId } },
          select: { id: true },
        });
        if (clash) throw new BookingInvariantError("teacher assignment row exists under a different identity");

        const teacherColumn = `teacher${command.skill}` as const;
        const emailColumn = `teacher${command.skill}Email` as const;
        const fields = { [teacherColumn]: command.teacher, [emailColumn]: command.email } as Record<string, string>;
        await tx.teacherAssignment.upsert({
          where: { id: assignmentId },
          create: { id: assignmentId, userId, legacyKey: bookingId, bookingId, ...fields },
          update: fields,
        });
        await this.hit("teacher.after_assignment");

        const updated = await tx.booking.update({ where: { id: bookingId }, data: fields });
        return { kind: "assigned", booking: toBookingRecord(updated as unknown as BookingRow) };
      });
    });
  }

  // ---- reads --------------------------------------------------------------------

  async listByUser(userId: string): Promise<Array<Partial<BookingRecord>>> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return [];
    return runPersistence({ table: "bookings", operation: "booking.list_by_user" }, async () => {
      const rows = await this.getClient().booking.findMany({
        where: { userId: id },
        orderBy: [{ bookingDate: "desc" }, { id: "desc" }],
      });
      return rows.map((row) => toProjectedRecord(row as unknown as BookingRow, "user"));
    });
  }

  private adminWhere(filter: AdminListFilter): Prisma.BookingWhereInput | null {
    const where: Prisma.BookingWhereInput = {};
    if (filter.location !== undefined) {
      if (filter.location !== "Home" && filter.location !== "Test Center") return null;
      where.location = LOCATION_FROM_WIRE[filter.location];
    }
    if (filter.status !== undefined) {
      if (!["Present", "Absent", "pending", "completed", "missed"].includes(filter.status)) return null;
      where.status = filter.status as BookingStatusWire;
    }
    return where;
  }

  private async timed<T>(operation: string, timeoutMs: number, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await runPersistence({ table: "bookings", operation }, () => runWithStatementTimeout(this.getClient(), timeoutMs, fn));
    } catch (error) {
      if ((error instanceof PersistenceError && error.kind === "TIMEOUT") || isStatementTimeout(error)) {
        throw new BookingQueryTimeoutError();
      }
      throw error;
    }
  }

  async listAdmin(filter: AdminListFilter, params: { skip: number; limit: number }): Promise<Array<Partial<BookingRecord>>> {
    const where = this.adminWhere(filter);
    if (!where) return [];
    return this.timed("booking.list_admin", 9000, async (tx) => {
      const rows = await tx.booking.findMany({ where, orderBy: { id: "desc" }, skip: params.skip, take: params.limit });
      return rows.map((row) => toProjectedRecord(row as unknown as BookingRow, "user"));
    });
  }

  async countAdmin(filter: AdminListFilter): Promise<number> {
    const where = this.adminWhere(filter);
    if (!where) return 0;
    return this.timed("booking.count_admin", 5000, (tx) => tx.booking.count({ where }));
  }

  async listBySchedule(scheduleId: string, params: { skip: number; limit: number }): Promise<Array<Partial<BookingRecord>>> {
    const id = toCanonicalObjectIdHex(scheduleId);
    if (!id) return [];
    return this.timed("booking.list_by_schedule", 8000, async (tx) => {
      const rows = await tx.booking.findMany({ where: { scheduleId: id }, orderBy: { id: "desc" }, skip: params.skip, take: params.limit });
      return rows.map((row) => toProjectedRecord(row as unknown as BookingRow, "bySchedule"));
    });
  }

  async listHomeWithUsers(): Promise<HomeBookingWithUser[]> {
    return this.timed("booking.list_home_with_users", 9000, async (tx) => {
      const bookings = await tx.booking.findMany({ where: { location: "Home" }, orderBy: { id: "asc" } });
      const ids = [...new Set(bookings.map((b) => b.userId))];
      const users = await tx.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true, contactNo: true, transactionId: true, mock: true, totalMock: true, status: true, passportNumber: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      const out: HomeBookingWithUser[] = [];
      for (const b of bookings) {
        const u = byId.get(b.userId);
        if (!u) continue; // legacy $unwind dropped bookings whose user is missing
        const user: HomeBookingWithUser["user"] = { _id: u.id, name: u.name, email: u.email, mock: u.mock, totalMock: u.totalMock };
        if (u.contactNo !== null) user.contactNo = u.contactNo;
        if (u.transactionId !== null) user.transactionId = u.transactionId;
        if (u.status !== null) user.status = u.status;
        if (u.passportNumber !== null) user.passportNumber = u.passportNumber;
        const record = toBookingRecord(b as unknown as BookingRow);
        const item: HomeBookingWithUser = {
          _id: record._id,
          name: record.name,
          testType: record.testType,
          location: record.location,
          bookingDate: record.bookingDate,
          userId: record.userId,
          user,
        };
        if (record.testSystem !== undefined) item.testSystem = record.testSystem;
        if (record.testTime !== undefined) item.testTime = record.testTime;
        if (record.attendance !== undefined) item.attendance = record.attendance;
        out.push(item);
      }
      return out;
    });
  }

  async attendanceCounts(userIds: string[]): Promise<Record<string, number>> {
    const ids = userIds.map((id) => toCanonicalObjectIdHex(id)).filter((id): id is string => id !== null);
    if (ids.length === 0) return {};
    return this.timed("booking.attendance_counts", 5000, async (tx) => {
      const rows = await tx.booking.groupBy({
        by: ["userId"],
        where: { userId: { in: ids }, attendance: { in: ["present", "absent"] } },
        _count: { _all: true },
      });
      const out: Record<string, number> = {};
      for (const row of rows) out[row.userId] = row._count._all;
      return out;
    });
  }

  async updateAttendance(
    target: AttendanceTarget,
    values: { status: BookingStatusWire; attendance: string }
  ): Promise<AttendanceOutcome> {
    const userId = toCanonicalObjectIdHex(target.userId);
    if (!userId) return { kind: "not_found" };
    return runPersistence({ table: "bookings", operation: "booking.update_attendance" }, async () => {
      const client = this.getClient();
      const where =
        target.kind === "home"
          ? { userId, location: "Home" as const, bookingDate: parseDateOnly(target.bookingDate) }
          : { userId, scheduleId: toCanonicalObjectIdHex(target.scheduleId) ?? "" };
      const row = await client.booking.findFirst({ where, orderBy: { id: "asc" } });
      if (!row) return { kind: "not_found" } as AttendanceOutcome;
      if (row.status === values.status && row.attendance === values.attendance) return { kind: "unchanged" } as AttendanceOutcome;
      await client.booking.update({ where: { id: row.id }, data: { status: values.status, attendance: values.attendance } });
      return { kind: "updated" } as AttendanceOutcome;
    });
  }
}
