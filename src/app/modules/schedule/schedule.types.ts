// Open record: never drop unknown fields from stored documents.
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

export type CreateScheduleEntryInput = Record<string, unknown>;

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

export interface MonthRange {
  startInclusive: string;
  endExclusive: string;
}

// Controller maps this to 504; repository and service stay HTTP-independent.
export class ScheduleQueryTimeoutError extends Error {
  constructor() {
    super("Query timed out.");
    this.name = "ScheduleQueryTimeoutError";
  }
}
