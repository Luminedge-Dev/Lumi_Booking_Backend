import { PersistenceError } from "../../database/persistence-error";
import { logger } from "../../shared/logger/logger";
import { newObjectIdHex } from "../../shared/utils/object-id";
import type { AuthActor } from "../auth/auth.types";
import type { BookingRepository } from "./booking.repository";
import {
  isHomeBookingAllowed,
  parseBookingStatus,
  parseCalendarDateString,
  parseObjectIdParam,
  parsePagination,
  parseTeacherSkill,
  parseTestType,
  trimmedString,
} from "./booking.validation";
import {
  BookingError,
  type BookedRecord,
  type BookingRecord,
  type BookingUserContext,
  type EntitlementPolicy,
  type HomeBookingWithUser,
} from "./booking.types";

// Side effects that must run only after a successful commit. The service
// calls these after the repository returns; a notifier failure never alters
// the HTTP result (same contract as the legacy waitUntil(...) calls).
export interface BookingNotifier {
  bookingConfirmed(user: Pick<BookingUserContext, "name" | "email">, booking: BookedRecord): void;
  attendanceRecorded(user: Pick<BookingUserContext, "name" | "email">, attendance: string, formattedDate: string): void;
}

const INSUFFICIENT_CREDIT = "Insufficient mock tests available.";
const SLOT_TAKEN = "This time slot was just taken. Please pick another.";
const STAFF_ROLES = ["admin", "bdm", "teacher"];

const fail = (status: number, message: string): BookingError => new BookingError(status, { message });

const formatLongDate = (value: string): string =>
  new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

export class BookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly notifier: BookingNotifier
  ) {}

  private safeNotify(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logger.error("booking_notification_error", { label, error: (error as Error)?.message });
    }
  }

  // ---- POST /user/book-slot --------------------------------------------------

  async bookSlot(actor: AuthActor, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, testType, name, location } = body;

    if (!userId || !location) {
      throw fail(400, "Missing required fields. 'userId' and 'location' are required.");
    }
    const targetUserId = parseObjectIdParam(userId);
    if (!targetUserId) throw fail(400, "Invalid user ID format.");

    // Actor authority comes from the verified token, never from the body.
    if (actor.role !== "admin" && targetUserId !== parseObjectIdParam(String(actor.userId))) {
      throw fail(403, "Forbidden");
    }

    const user = await this.repository.findUserContext(targetUserId);
    if (!user || user.mock <= 0) throw fail(400, INSUFFICIENT_CREDIT);

    const resolvedMockType = trimmedString(name || user.mockType);
    const resolvedTestType = trimmedString(testType || user.testType);

    let entitlement: EntitlementPolicy | null = null;
    if (resolvedMockType && resolvedTestType) {
      entitlement = { mockType: resolvedMockType, testType: resolvedTestType };
      const { purchased, used } = await this.repository.entitlementUsage(targetUserId, entitlement);
      if (purchased > 0 && used >= purchased) throw fail(400, INSUFFICIENT_CREDIT);
    }

    if (location === "Home") return this.bookHome(user, targetUserId, body, resolvedMockType, entitlement);
    if (location === "Test Center") return this.bookTestCenter(user, targetUserId, body, entitlement);
    throw fail(400, "Invalid location type. Must be 'Home' or 'Test Center'.");
  }

  private async bookHome(
    user: BookingUserContext,
    userId: string,
    body: Record<string, unknown>,
    resolvedMockType: string,
    entitlement: EntitlementPolicy | null
  ): Promise<Record<string, unknown>> {
    const { testType, testSystem, name, bookingDate, testTime } = body;
    if (!bookingDate || !testTime) throw fail(400, "Please select a booking date and test time.");

    const userTestType = testType || user.testType || "Unknown";
    const userTestName = name || user.name || "Unknown";

    // Course-level Home eligibility is enforced before any state change.
    if (resolvedMockType) {
      const homeSystems = await this.repository.findHomeSystems(resolvedMockType);
      if (!isHomeBookingAllowed(homeSystems, [testSystem, userTestType])) {
        throw fail(
          400,
          "This course is not available for Home-based mock tests with the selected test system. Please book at a Test Center."
        );
      }
    }

    // Persistence-forced validation (D-039 A1): DATE column and closed enum.
    const date = parseCalendarDateString(bookingDate);
    if (!date) throw fail(400, "Invalid booking date. Expected YYYY-MM-DD.");
    const parsedTestType = parseTestType(userTestType);
    if (!parsedTestType) throw fail(400, "Invalid test type. Expected 'Computer-Based' or 'Paper-Based'.");

    const outcome = await this.repository.createHomeBooking({
      bookingId: newObjectIdHex(),
      userId,
      name: String(userTestName),
      testType: parsedTestType,
      testSystem: testSystem ? String(testSystem) : "N/A",
      bookingDate: date,
      testTime: String(testTime),
      entitlement,
    });

    switch (outcome.kind) {
      case "insufficient_credit":
        throw fail(400, INSUFFICIENT_CREDIT);
      case "duplicate":
        throw fail(400, "You already have a test booked for this date.");
      case "slot_taken":
        throw fail(400, SLOT_TAKEN);
      case "booked":
        this.safeNotify("home_booking_confirmation", () => this.notifier.bookingConfirmed(user, outcome.booking));
        return { success: true, message: "Home test booked successfully", bookingRecord: outcome.booking };
    }
  }

  private async bookTestCenter(
    user: BookingUserContext,
    userId: string,
    body: Record<string, unknown>,
    entitlement: EntitlementPolicy | null
  ): Promise<Record<string, unknown>> {
    const { scheduleId, slotId, testType, testSystem, name } = body;
    if (!scheduleId || !slotId || !testType || !name) {
      throw fail(
        400,
        "Missing required fields: 'scheduleId', 'slotId', 'testType', and 'name' are required for Test Center bookings."
      );
    }
    if (typeof testSystem === "string" && testSystem.trim() === "") {
      throw fail(400, "'testSystem' is required because a selection field was shown.");
    }
    const canonicalScheduleId = parseObjectIdParam(scheduleId);
    if (!canonicalScheduleId) throw fail(400, "Invalid schedule ID format.");

    const schedule = await this.repository.findScheduleSlot(canonicalScheduleId, String(slotId));
    if (!schedule) throw fail(404, "Schedule not found.");
    if (!schedule.slot || Number(schedule.slot.seatsLeft) < 1) {
      throw fail(400, "Invalid or unavailable time slot selected.");
    }

    const parsedTestType = parseTestType(testType);
    if (!parsedTestType) throw fail(400, "Invalid test type. Expected 'Computer-Based' or 'Paper-Based'.");

    try {
      const outcome = await this.repository.createTestCenterBooking({
        bookingId: newObjectIdHex(),
        userId,
        scheduleId: canonicalScheduleId,
        slotId: schedule.slot.slotId,
        name: String(name),
        testType: parsedTestType,
        testSystem: testSystem ? String(testSystem) : null,
        bookingDate: schedule.startDate,
        startTime: schedule.slot.startTime,
        endTime: schedule.slot.endTime,
        entitlement,
      });

      switch (outcome.kind) {
        case "insufficient_credit":
          throw fail(400, INSUFFICIENT_CREDIT);
        case "duplicate":
          throw fail(400, "You have already booked a slot for this date.");
        case "slot_taken":
          throw fail(400, SLOT_TAKEN);
        case "booked":
          this.safeNotify("test_center_booking_confirmation", () => this.notifier.bookingConfirmed(user, outcome.booking));
          return { success: true, message: "Test Center test booked successfully", bookingRecord: outcome.booking };
      }
    } catch (error) {
      // Serialization retries exhausted: the legacy transient-write-conflict
      // path answered 409 with the slot-taken message (D-039 A2).
      if (error instanceof PersistenceError && error.conflict) throw fail(409, SLOT_TAKEN);
      throw error;
    }
  }

  // ---- DELETE /bookings/:bookingId -------------------------------------------

  async cancel(actor: AuthActor, bookingIdParam: string): Promise<Record<string, unknown>> {
    const bookingId = parseObjectIdParam(bookingIdParam);
    if (!bookingId) throw fail(400, "Invalid booking ID format.");

    const outcome = await this.repository.cancelBooking({
      bookingId,
      actorUserId: parseObjectIdParam(String(actor.userId)) ?? String(actor.userId),
      actorIsAdmin: actor.role === "admin",
    });
    switch (outcome.kind) {
      case "not_found":
        throw fail(404, "Booking not found.");
      case "forbidden":
        throw fail(403, "Forbidden");
      case "credit_restore_failed":
        throw fail(500, "Failed to update mock count.");
      case "cancelled":
        return { success: true, message: "Booking canceled successfully, and mock count restored" };
    }
  }

  // ---- reads ---------------------------------------------------------------------

  async listForUser(actor: AuthActor, userId: string): Promise<{ bookings: Array<Partial<BookingRecord>> }> {
    const self = String(actor.userId);
    if (!STAFF_ROLES.includes(actor.role ?? "") && userId !== self) throw fail(403, "Forbidden");
    return { bookings: await this.repository.listByUser(userId) };
  }

  async listHomeWithUsers(): Promise<{ bookings: HomeBookingWithUser[] }> {
    return { bookings: await this.repository.listHomeWithUsers() };
  }

  async listBySchedule(scheduleId: string, query: Record<string, unknown>) {
    if (!scheduleId) throw fail(400, "scheduleId is required");
    const { page, limit, skip } = parsePagination(query);
    const bookings = await this.repository.listBySchedule(scheduleId, { skip, limit });
    return { bookings, page, limit };
  }

  async listAdmin(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const filter = {
      ...(query.location ? { location: String(query.location) } : {}),
      ...(query.status ? { status: String(query.status) } : {}),
    };
    const [bookings, total] = await Promise.all([
      this.repository.listAdmin(filter, { skip, limit }),
      page === 1 ? this.repository.countAdmin(filter) : Promise.resolve<number | null>(null),
    ]);
    if (bookings.length === 0 && page === 1) throw fail(404, "No bookings found");
    return { bookings, ...(total !== null && { total }), page, limit };
  }

  async attendanceCounts(userIds: unknown): Promise<{ attendance: Record<string, number> }> {
    if (!userIds || !Array.isArray(userIds)) throw new BookingError(400, { error: "Invalid userIds format" });
    const ids = userIds.filter((id): id is string => typeof id === "string");
    return { attendance: await this.repository.attendanceCounts(ids) };
  }

  // ---- PUT /user/bookings/:scheduleId (attendance) -----------------------------------

  async updateAttendance(scheduleIdParam: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, attendance, status, bookingDate } = body;
    if (!userId || !attendance || !status) throw fail(400, "Missing required fields.");

    const isHome = scheduleIdParam.toLowerCase() === "home";
    const targetUserId = parseObjectIdParam(userId);
    let target;
    let formattedDate: string;

    if (isHome) {
      if (!bookingDate) throw fail(400, "Booking date is required for Home bookings.");
      if (Number.isNaN(new Date(String(bookingDate)).getTime())) throw fail(400, "Invalid booking date format.");
      const date = parseCalendarDateString(bookingDate);
      if (!date) throw fail(400, "Invalid booking date format.");
      formattedDate = formatLongDate(String(bookingDate));
      target = { kind: "home" as const, userId: targetUserId ?? "", bookingDate: date };
    } else {
      const scheduleId = parseObjectIdParam(scheduleIdParam);
      if (!scheduleId) throw fail(400, "Invalid schedule ID format.");
      const schedule = await this.repository.findScheduleSlot(scheduleId, "");
      if (!schedule) throw fail(404, "Schedule not found");
      formattedDate = formatLongDate(schedule.startDate);
      target = { kind: "schedule" as const, userId: targetUserId ?? "", scheduleId };
    }

    // Persistence-forced validation (D-039 A1): status is a closed enum.
    const parsedStatus = parseBookingStatus(status);
    if (!parsedStatus) {
      throw fail(400, "Invalid status. Expected one of: Present, Absent, pending, completed, missed.");
    }

    const outcome = await this.repository.updateAttendance(target, { status: parsedStatus, attendance: String(attendance) });
    if (outcome.kind === "not_found") throw fail(404, "Booking not found.");
    if (outcome.kind === "unchanged") return { message: "Attendance already updated." };

    const user = targetUserId ? await this.repository.findUserContext(targetUserId) : null;
    if (!user) throw fail(404, "User not found.");

    const message = `Attendance updated successfully for ${isHome ? "Home" : "Test Center"} booking.`;
    if (attendance === "present" || attendance === "absent") {
      this.safeNotify("attendance_email", () => this.notifier.attendanceRecorded(user, attendance, formattedDate));
    }
    return { success: true, message };
  }

  // ---- PUT /admin/bookings/:bookingId/teacher -----------------------------------------

  async assignTeacher(bookingIdParam: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bookingId = parseObjectIdParam(bookingIdParam);
    if (!bookingId) throw fail(400, "Invalid booking ID.");
    const skill = parseTeacherSkill(body.skill);
    if (!skill) throw fail(400, "Invalid skill parameter");
    const { teacher, email } = body;
    if (!teacher || !email || typeof teacher !== "string" || typeof email !== "string") {
      throw fail(400, "Teacher and email are required");
    }

    const outcome = await this.repository.assignTeacher({ bookingId, skill, teacher, email: email.toLowerCase().trim() });
    if (outcome.kind === "not_found") throw fail(404, "Home booking not found");
    return { success: true, message: `Teacher for ${skill} updated for home booking`, booking: outcome.booking };
  }
}
