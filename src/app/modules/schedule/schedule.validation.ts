import { ObjectId } from "mongodb";
import type { CreateScheduleEntryInput, MonthRange, NormalizedTimeSlot, ParsedCreateScheduleEntry } from "./schedule.types";

// Pure parsers only -- no Express coupling, no throwing. schedule.route.ts
// wraps these into thin adapters that write the exact legacy/new-route
// response on failure.
//
// DELIBERATELY ASYMMETRIC across routes (same lesson Stage 8 learned with
// request-profile-edit's `note` field): only the DELETE route (already
// strict today) and the brand-new monthly route (which Stage 9 itself
// owns) get strict validation here. The existing daily route
// (GET /schedule/:date/:courseId) and the admin-list route get NO new
// validation -- confirmed by direct code read that legacy queries their
// params/query as raw strings with no ObjectId/format check at all. Adding
// one now would be an untested Stage 9 behavior change, not a migration.

export function isValidScheduleIdParam(id: unknown): id is string {
  return typeof id === "string" && ObjectId.isValid(id);
}

export function isValidCourseIdParam(courseId: unknown): courseId is string {
  return typeof courseId === "string" && ObjectId.isValid(courseId);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Strict, monthly-route-only. Returns STRING boundaries, never Date objects
// -- schedules.startDate is a "YYYY-MM-DD" string, and comparing a string
// field against Date $gte/$lt values would silently fail to match or
// produce wrong results (Mongo compares by BSON type first). Pure
// string/integer arithmetic, zero-padded, with December->January rollover;
// no timezone conversion anywhere.
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
//
// Must stay compatibility-tolerant, not become a new DTO contract. Legacy's
// actual rules, reproduced exactly (confirmed by direct code read, not
// assumed): required-ness is a TRUTHINESS check
// (`!courseId || !startDate || !endDate`), not a type check -- no
// z.string() requirement that would reject a value legacy would silently
// accept. Defaults use `??` (nullish coalescing, not `||`): a
// deliberately-falsy-but-non-nullish value (e.g. status: 0) passes through
// unchanged under `??` but would be silently replaced under `||`.

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

// Reproduces legacy's normalizeIncomingSlot (routes/schedule.routes.js:16-25)
// via direct property access, NOT a Zod object parse -- a strict schema is
// both stricter and looser than legacy in ways that change the create
// contract: primitives (false/0/"x") are boxed on property access and
// succeed with undefined fields (legacy accepts, z.object().parse() would
// throw), while null/undefined genuinely throw a TypeError on access
// (legacy's own request-level 500 -- swallowing that into `?? {}` would
// silently turn a legacy 500 into a successful native insert). The throw
// here is intentional and uncaught -- it propagates through
// schedule.service.ts to schedule.controller.ts's existing try/catch.
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

// Returns null ONLY when the entry fails legacy's required-field
// truthiness check -- the caller (schedule.service.ts) is responsible for
// pushing the correct failedSchedules[] message ("Missing
// courseId/startDate/endDate" vs "No time slots provided.") since both
// failure modes share this same "admissible but not processable" shape at
// the type level. This function performs the courseId/startDate/endDate
// truthiness check only.
//
// Deliberately returns RAW, un-normalized `timeSlots` (not run through
// normalizeIncomingSlot here) -- legacy's own operation order reads the
// max-slot-ID from Mongo BEFORE normalizing/checking timeSlots
// (routes/schedule.routes.js:84-94). Keeping this parser pure (no Mongo
// dependency) while preserving that order means schedule.service.ts calls
// normalizeIncomingSlot itself, sequenced after its own findMaxSlotId call.
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

// Admin-list pagination: reimplements legacy's EXACT parseInt+clamp
// arithmetic as a plain function, not a Zod schema -- a z.coerce.number()
// schema would not necessarily reproduce parseInt's tolerance for garbage
// input (e.g. "2abc" -> parseInt gives 2; coerce.number() could reject or
// behave differently). page: clamped to a minimum of 1 only (no upper
// clamp, confirmed). limit: clamped to [1,500], defaulting to 100 when the
// parsed value is falsy (parseInt("0",10)===0 is falsy, so limit=0 maps to
// the 100 default, not to 1 -- a real legacy quirk, preserved).
export function parsePaginationParams(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(String(query.page ?? ""), 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(String(query.limit ?? ""), 10) || 100));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// Admin-list optional filters: String(...)-coerced, exact match only, no
// enum/format validation -- same as legacy.
export function parseAdminListFilter(query: Record<string, unknown>): { courseId?: string; status?: string } {
  const filter: { courseId?: string; status?: string } = {};
  if (query.courseId) filter.courseId = String(query.courseId);
  if (query.status) filter.status = String(query.status);
  return filter;
}
