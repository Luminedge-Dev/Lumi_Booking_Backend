import { z } from "zod";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import {
  BOOKING_STATUSES,
  TEACHER_SKILLS,
  TEST_TYPES,
  type BookingStatusWire,
  type TeacherSkill,
  type TestTypeWire,
} from "./booking.types";

// Persistence-forced validation (D-039 / approval A1): PostgreSQL stores
// bookingDate as DATE and testType/status as closed enums, so values the
// legacy Mongo path accepted verbatim must be rejected with a 400 here.

const testTypeSchema = z.enum(TEST_TYPES);
const bookingStatusSchema = z.enum(BOOKING_STATUSES);
const teacherSkillSchema = z.enum(TEACHER_SKILLS);

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Strict real-calendar-date check with no timezone arithmetic: the string is
// validated by component and never converted through a local-time Date.
export function parseCalendarDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return value;
}

export function parseTestType(value: unknown): TestTypeWire | null {
  const result = testTypeSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseBookingStatus(value: unknown): BookingStatusWire | null {
  const result = bookingStatusSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseTeacherSkill(value: unknown): TeacherSkill | null {
  const result = teacherSkillSchema.safeParse(value);
  return result.success ? result.data : null;
}

// Mirrors the legacy `ObjectId.isValid` gate, then canonicalizes to the
// lowercase 24-hex text PostgreSQL stores.
export function parseObjectIdParam(value: unknown): string | null {
  return toCanonicalObjectIdHex(value);
}

export function trimmedString(value: unknown): string {
  return (value ?? "").toString().trim();
}

// Legacy Home eligibility (per-course allow-list), preserved exactly.
const normalize = (v: unknown): string => (v ?? "").toString().trim().toLowerCase();

export function isHomeBookingAllowed(homeBasedSystems: string[] | null, candidateSystems: unknown[]): boolean {
  if (homeBasedSystems === null) return true; // no course row, or field absent
  const allowed = new Set(homeBasedSystems.map(normalize));
  return candidateSystems.some((v) => normalize(v) !== "" && allowed.has(normalize(v)));
}

export function parsePagination(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(String(query.page), 10) || 1);
  const limit = Math.min(2000, Math.max(1, parseInt(String(query.limit), 10) || 500));
  return { page, limit, skip: (page - 1) * limit };
}
