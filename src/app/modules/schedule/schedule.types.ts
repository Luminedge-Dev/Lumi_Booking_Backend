// Module-local types only (per AGENTS.md ss4a -- not the full Stage-6
// canonical Schedule model, assembled incrementally as modules migrate).

// Open/passthrough record: legacy's admin listing and daily read both
// return full documents with zero projection, and Stage 6 found 3 rare
// flattened Schedule documents that must not vanish or get coerced into a
// narrow shape. Typed for known fields, but never drops anything else a
// real document carries.
export interface ScheduleRecord extends Record<string, unknown> {
  _id: unknown;
  courseId?: string;
  startDate?: string;
  endDate?: string;
  name?: string;
  testSystem?: string;
  testType?: string;
  status?: string;
  timeSlots?: unknown[];
  createdAt?: string;
}

export interface NormalizedTimeSlot {
  startTime: string;
  endTime: string;
  slot: number;
  totalSlot: number;
}

// The raw, untrusted shape of one entry in the create-schedule request
// array -- deliberately `unknown`-typed fields, narrowed only by
// schedule.validation.ts's tolerant per-row parser.
export type CreateScheduleEntryInput = Record<string, unknown>;

// What schedule.validation.ts's parseCreateScheduleEntry produces for one
// ADMISSIBLE entry (courseId/startDate/endDate present, truthiness-checked
// only -- see schedule.validation.ts for why these stay loosely typed).
// timeSlots stays RAW/un-normalized here -- schedule.service.ts normalizes
// it (via normalizeIncomingSlot) only after its own findMaxSlotId call, to
// preserve legacy's exact operation order (read max-slot-ID before
// normalizing/checking timeSlots).
export interface ParsedCreateScheduleEntry {
  courseId: unknown;
  startDate: unknown;
  endDate: unknown;
  testType: unknown;
  name: unknown;
  testSystem: unknown;
  status: unknown;
  timeSlots: unknown[];
}

export interface SlotIdKey {
  courseId: unknown;
  startDate: unknown;
  endDate: unknown;
  testType: unknown;
}

export interface CreateScheduleSuccessItem {
  courseId: unknown;
  startDate: unknown;
  endDate: unknown;
  assignedSlotId: string;
  createdAt: string;
}

export interface CreateScheduleFailureItem {
  courseId: unknown;
  startDate: unknown;
  endDate: unknown;
  message: string;
  timestamp: string;
}

export interface CreateScheduleBatchResult {
  successful: CreateScheduleSuccessItem[];
  failed: CreateScheduleFailureItem[];
}

export interface AdminListFilter {
  courseId?: string;
  status?: string;
}

export interface AdminListParams {
  page: number;
  limit: number;
  skip: number;
}

export interface AdminListResult {
  schedules: ScheduleRecord[];
  total: number;
  page: number;
  limit: number;
}

// String boundaries, not JavaScript Date objects -- schedules.startDate is
// persisted as a "YYYY-MM-DD" string, never BSON Date (confirmed by the
// daily route's own exact-string match). See schedule.validation.ts's
// parseMonthParam.
export interface MonthRange {
  startInclusive: string;
  endExclusive: string;
}

// Repository throws this on a Mongo code-50 (MaxTimeMSExpired) failure from
// the admin-list query ONLY. Kept HTTP-independent (AGENTS.md ss11):
// schedule.controller.ts is the one place that maps it to
// 504 {message:"Query timed out."} -- schedule.repository.ts and
// schedule.service.ts never touch res/status codes. findByDateAndCourse
// must NOT use this (confirmed: that legacy route has no err.code===50
// branch, only a flat 500).
export class ScheduleQueryTimeoutError extends Error {
  constructor() {
    super("Query timed out.");
    this.name = "ScheduleQueryTimeoutError";
  }
}
