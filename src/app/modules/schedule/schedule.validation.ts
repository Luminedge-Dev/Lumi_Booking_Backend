import { ObjectId } from "mongodb";
import type { CreateScheduleEntryInput, MonthRange, NormalizedTimeSlot, ParsedCreateScheduleEntry } from "./schedule.types";

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
