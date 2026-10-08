import { ObjectId } from "mongodb";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import type {
  CreateScheduleEntryInput,
  MonthRange,
  NewScheduleRecord,
  NormalizedTimeSlot,
  ParsedCreateScheduleEntry,
  StorableScheduleStatus,
  StorableTestType,
} from "./schedule.types";

export function isValidScheduleIdParam(id: unknown): id is string {
  return typeof id === "string" && ObjectId.isValid(id);
}

export function isValidCourseIdParam(courseId: unknown): courseId is string {
  return typeof courseId === "string" && ObjectId.isValid(courseId);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseMonthParam(raw: unknown): MonthRange | null {
  if (typeof raw !== "string" || !MONTH_PATTERN.test(raw)) return null;
  const [yearStr, monthStr] = raw.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const startInclusive = `${yearStr}-${monthStr}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endExclusive = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return { startInclusive, endExclusive };
}

// --- create-schedule: tolerant, per-row compatibility parser -------------

function toHHMM(v: unknown): string {
  const [h = "0", m = "0"] = String(v || "").split(":");
  return `${pad2(+h)}:${pad2(+m)}`;
}
function toHHMMSS(v: string): string {
  const [h = "0", m = "0", s = "0"] = v.split(":");
  return `${pad2(+h)}:${pad2(+m)}:${pad2(+s)}`;
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeIncomingSlot(rawSlot: unknown): NormalizedTimeSlot {
  const slot = rawSlot as Record<string, unknown>;
  const s = toHHMM(slot.startTime);
  const e = toHHMM(slot.endTime);
  return {
    startTime: toHHMMSS(s),
    endTime: toHHMMSS(e),
    slot: Number((slot.slot as number | string | undefined) ?? 0),
    totalSlot: Number((slot.totalSlot as number | string | undefined) ?? (slot.slot as number | string | undefined) ?? 0),
  };
}

export function parseCreateScheduleEntry(raw: CreateScheduleEntryInput): ParsedCreateScheduleEntry | null {
  const { courseId, startDate, endDate, testType } = raw ?? {};
  if (!courseId || !startDate || !endDate) return null;

  return {
    courseId,
    startDate,
    endDate,
    testType,
    name: raw.name ?? "",
    testSystem: raw.testSystem ?? "",
    status: raw.status ?? "Scheduled",
    timeSlots: Array.isArray(raw.timeSlots) ? raw.timeSlots : [],
  };
}

export function parsePaginationParams(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(String(query.page ?? ""), 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(String(query.limit ?? ""), 10) || 100));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function parseAdminListFilter(query: Record<string, unknown>): { courseId?: string; status?: string } {
  const filter: { courseId?: string; status?: string } = {};
  if (query.courseId) filter.courseId = String(query.courseId);
  if (query.status) filter.status = String(query.status);
  return filter;
}

// --- Stage 15: PostgreSQL storability ------------------------------------
// Mongo accepted any value in these fields; the relational schema cannot
// (closed enums, real calendar dates, 32-bit integers, no NUL). Entries that
// cannot be stored are reported per entry in failedSchedules[] with a fixed
// message that never echoes input. Documented intentional difference.

export const STORABLE_TEST_TYPES: readonly StorableTestType[] = ["Computer-Based", "Paper-Based"];
export const STORABLE_STATUSES: readonly StorableScheduleStatus[] = ["Scheduled", "Cancelled"];

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseCalendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function isInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

export type StorableResult = { ok: true; value: Omit<NewScheduleRecord, "timeSlots" | "createdAt"> } | { ok: false; message: string };

export function toStorableSchedule(parsed: ParsedCreateScheduleEntry, slots: NormalizedTimeSlot[]): StorableResult {
  const courseId = toCanonicalObjectIdHex(parsed.courseId);
  if (!courseId) return { ok: false, message: "courseId must be a valid course id" };
  if (!isRealCalendarDate(parsed.startDate) || !isRealCalendarDate(parsed.endDate)) {
    return { ok: false, message: "startDate and endDate must be YYYY-MM-DD calendar dates" };
  }
  if (!STORABLE_TEST_TYPES.includes(parsed.testType as StorableTestType)) {
    return { ok: false, message: "testType must be Computer-Based or Paper-Based" };
  }
  if (!STORABLE_STATUSES.includes(parsed.status as StorableScheduleStatus)) {
    return { ok: false, message: "status must be Scheduled or Cancelled" };
  }
  if (typeof parsed.name !== "string" || typeof parsed.testSystem !== "string") {
    return { ok: false, message: "name and testSystem must be text" };
  }
  if (hasNul(parsed.name) || hasNul(parsed.testSystem)) {
    return { ok: false, message: "name and testSystem must not contain NUL characters" };
  }
  for (const slot of slots) {
    if (!isInt32(slot.slot) || !isInt32(slot.totalSlot)) {
      return { ok: false, message: "slot and totalSlot must be whole numbers" };
    }
  }
  return {
    ok: true,
    value: {
      courseId,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      name: parsed.name,
      testSystem: parsed.testSystem,
      testType: parsed.testType as StorableTestType,
      status: parsed.status as StorableScheduleStatus,
    },
  };
}
