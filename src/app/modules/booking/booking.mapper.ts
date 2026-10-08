import type { BookedRecord, BookingLocationWire, BookingRecord, BookingStatusWire, TestTypeWire } from "./booking.types";

// Row shape as Prisma returns it (enum members use their schema identifiers).
export interface BookingRow {
  id: string;
  userId: string;
  scheduleId: string | null;
  slotId: string | null;
  name: string;
  location: "Home" | "TestCenter";
  bookingDate: Date;
  status: BookingStatusWire;
  attendance: string | null;
  testType: "ComputerBased" | "PaperBased";
  testSystem: string | null;
  testTime: string | null;
  startTime: string | null;
  endTime: string | null;
  teacherL: string | null;
  teacherLEmail: string | null;
  teacherR: string | null;
  teacherREmail: string | null;
  teacherW: string | null;
  teacherWEmail: string | null;
  teacherS: string | null;
  teacherSEmail: string | null;
  trfEmailed: boolean | null;
  trfEmailAt: Date | null;
}

export const LOCATION_TO_WIRE: Record<BookingRow["location"], BookingLocationWire> = { Home: "Home", TestCenter: "Test Center" };
export const LOCATION_FROM_WIRE: Record<BookingLocationWire, BookingRow["location"]> = { Home: "Home", "Test Center": "TestCenter" };
export const TEST_TYPE_TO_WIRE: Record<BookingRow["testType"], TestTypeWire> = { ComputerBased: "Computer-Based", PaperBased: "Paper-Based" };
export const TEST_TYPE_FROM_WIRE: Record<TestTypeWire, BookingRow["testType"]> = { "Computer-Based": "ComputerBased", "Paper-Based": "PaperBased" };

// bookings.booking_date is a DATE column; Prisma returns it at UTC midnight.
export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

// Legacy documents omit unset fields, so nulls are dropped, never serialized.
function put<K extends keyof BookingRecord>(target: BookingRecord, key: K, value: BookingRecord[K] | null): void {
  if (value !== null && value !== undefined) target[key] = value;
}

export function toBookingRecord(row: BookingRow): BookingRecord {
  const record: BookingRecord = {
    _id: row.id,
    userId: row.userId,
    name: row.name,
    location: LOCATION_TO_WIRE[row.location],
    bookingDate: dateOnly(row.bookingDate),
    status: row.status,
    testType: TEST_TYPE_TO_WIRE[row.testType],
  };
  put(record, "scheduleId", row.scheduleId);
  put(record, "slotId", row.slotId);
  put(record, "attendance", row.attendance);
  put(record, "testSystem", row.testSystem);
  put(record, "testTime", row.testTime);
  put(record, "startTime", row.startTime);
  put(record, "endTime", row.endTime);
  put(record, "teacherL", row.teacherL);
  put(record, "teacherLEmail", row.teacherLEmail);
  put(record, "teacherR", row.teacherR);
  put(record, "teacherREmail", row.teacherREmail);
  put(record, "teacherW", row.teacherW);
  put(record, "teacherWEmail", row.teacherWEmail);
  put(record, "teacherS", row.teacherS);
  put(record, "teacherSEmail", row.teacherSEmail);
  put(record, "trfEmailed", row.trfEmailed);
  put(record, "trfEmailAt", row.trfEmailAt);
  return record;
}

// Legacy read projections.
const USER_AND_ADMIN_PROJECTION = [
  "_id", "userId", "scheduleId", "slotId", "name", "testType", "testSystem", "location", "bookingDate",
  "testTime", "startTime", "endTime", "status", "attendance", "trfEmailed", "trfEmailAt",
] as const;
const BY_SCHEDULE_PROJECTION = [
  "_id", "name", "testType", "testSystem", "bookingDate", "scheduleId", "slotId", "startTime", "endTime", "userId", "attendance",
] as const;

export type BookingProjection = "user" | "bySchedule";

export function toProjectedRecord(row: BookingRow, projection: BookingProjection): Partial<BookingRecord> {
  const full = toBookingRecord(row) as unknown as Record<string, unknown>;
  const keys: readonly string[] = projection === "user" ? USER_AND_ADMIN_PROJECTION : BY_SCHEDULE_PROJECTION;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in full) out[key] = full[key];
  return out as Partial<BookingRecord>;
}

// Response of POST /user/book-slot: the inserted document, as before.
export function toBookedRecord(input: {
  id: string;
  userId: string;
  scheduleId?: string;
  slotId?: string;
  name: string;
  location: BookingLocationWire;
  bookingDate: string;
  testType: TestTypeWire;
  testSystem: string | null;
  testTime?: string;
  startTime?: string;
  endTime?: string;
}): BookedRecord {
  const record: BookedRecord = {
    _id: input.id,
    userId: input.userId,
    name: input.name,
    location: input.location,
    bookingDate: input.bookingDate,
    status: "pending",
    testType: input.testType,
  };
  if (input.scheduleId !== undefined) record.scheduleId = input.scheduleId;
  if (input.slotId !== undefined) record.slotId = input.slotId;
  // Legacy Test Center bookings persisted `testSystem: null` explicitly; Home always carries a string.
  if (input.testSystem !== null || input.location === "Test Center") record.testSystem = input.testSystem;
  if (input.testTime !== undefined) record.testTime = input.testTime;
  if (input.startTime !== undefined) record.startTime = input.startTime;
  if (input.endTime !== undefined) record.endTime = input.endTime;
  return record;
}
