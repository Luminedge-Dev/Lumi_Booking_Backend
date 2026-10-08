// Booking module types. The wire record mirrors the legacy Mongo document
// (`_id`, optional fields omitted rather than null) so API consumers see the
// same shape they saw before the PostgreSQL move.

export const BOOKING_LOCATIONS = ["Home", "Test Center"] as const;
export type BookingLocationWire = (typeof BOOKING_LOCATIONS)[number];

export const TEST_TYPES = ["Computer-Based", "Paper-Based"] as const;
export type TestTypeWire = (typeof TEST_TYPES)[number];

export const BOOKING_STATUSES = ["Present", "Absent", "pending", "completed", "missed"] as const;
export type BookingStatusWire = (typeof BOOKING_STATUSES)[number];

export const TEACHER_SKILLS = ["L", "W", "R", "S"] as const;
export type TeacherSkill = (typeof TEACHER_SKILLS)[number];

export interface BookingRecord {
  _id: string;
  userId: string;
  scheduleId?: string;
  slotId?: string;
  name: string;
  location: BookingLocationWire;
  bookingDate: string;
  status: BookingStatusWire;
  attendance?: string;
  testType: TestTypeWire;
  testSystem?: string;
  testTime?: string;
  startTime?: string;
  endTime?: string;
  teacherL?: string;
  teacherLEmail?: string;
  teacherR?: string;
  teacherREmail?: string;
  teacherW?: string;
  teacherWEmail?: string;
  teacherS?: string;
  teacherSEmail?: string;
  trfEmailed?: boolean;
  trfEmailAt?: Date;
}

// Response shape of POST /user/book-slot (the legacy handler returned the
// inserted document, which carried the driver-assigned `_id`).
export type BookedRecord = Omit<BookingRecord, "testSystem" | "attendance" | "teacherL" | "teacherLEmail" | "teacherR" | "teacherREmail" | "teacherW" | "teacherWEmail" | "teacherS" | "teacherSEmail" | "trfEmailed" | "trfEmailAt"> & { testSystem?: string | null };

// What the booking workflows need to know about the booking's owner. Never
// includes the password hash.
export interface BookingUserContext {
  id: string;
  name: string;
  email: string;
  mock: number;
  mockType: string | null;
  testType: string | null;
}

export interface ScheduleSlotContext {
  scheduleId: string;
  startDate: string;
  slot: { slotId: string; seatsLeft: number; startTime: string; endTime: string } | null;
}

// ---- repository command / outcome types -----------------------------------

export interface EntitlementPolicy {
  // Present only when both the resolved course name and test type are known;
  // mirrors the legacy `purchasedForCourse` / `usedForCourse` guard.
  mockType: string;
  testType: string;
}

export interface HomeBookingCommand {
  bookingId: string;
  userId: string;
  name: string;
  testType: TestTypeWire;
  testSystem: string;
  bookingDate: string;
  testTime: string;
  entitlement: EntitlementPolicy | null;
}

export interface TestCenterBookingCommand {
  bookingId: string;
  userId: string;
  scheduleId: string;
  slotId: string;
  name: string;
  testType: TestTypeWire;
  testSystem: string | null;
  bookingDate: string;
  startTime: string;
  endTime: string;
  entitlement: EntitlementPolicy | null;
}

export type BookOutcome =
  | { kind: "booked"; booking: BookedRecord }
  | { kind: "insufficient_credit" }
  | { kind: "duplicate" }
  | { kind: "slot_taken" };

export interface CancelCommand {
  bookingId: string;
  // Verified actor. Ownership is re-checked after the row locks are held.
  actorUserId: string;
  actorIsAdmin: boolean;
}

export type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "credit_restore_failed" };

export interface AssignTeacherCommand {
  bookingId: string;
  skill: TeacherSkill;
  teacher: string;
  email: string;
}

export type AssignTeacherOutcome = { kind: "assigned"; booking: BookingRecord } | { kind: "not_found" };

export interface BookingExistingRef {
  id: string;
  userId: string;
  location: BookingLocationWire;
}

export interface AdminListFilter {
  location?: string;
  status?: string;
}

export interface HomeBookingWithUser {
  _id: string;
  name: string;
  testType: TestTypeWire;
  testSystem?: string;
  location: BookingLocationWire;
  bookingDate: string;
  testTime?: string;
  attendance?: string;
  userId: string;
  user: {
    _id: string;
    name: string;
    email: string;
    contactNo?: string;
    transactionId?: string;
    mock: number;
    totalMock: number;
    status?: string;
    passportNumber?: string;
  };
}

export type AttendanceTarget =
  | { kind: "home"; userId: string; bookingDate: string }
  | { kind: "schedule"; userId: string; scheduleId: string };

export type AttendanceOutcome = { kind: "not_found" } | { kind: "unchanged" } | { kind: "updated" };

export class BookingQueryTimeoutError extends Error {
  constructor() {
    super("Booking query timed out");
    this.name = "BookingQueryTimeoutError";
  }
}

// Domain error carrying the exact legacy HTTP contract for the failure.
export class BookingError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.message === "string" ? body.message : "Booking error");
    this.name = "BookingError";
  }
}
