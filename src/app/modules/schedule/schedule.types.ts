// Public schedule shape (legacy field names). Persisted in PostgreSQL since
// Stage 15; only modeled columns exist, so fields outside the Stage 13 schema
// are not carried (declared intentional difference vs Mongo passthrough).
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
  createdAt?: string | Date;
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

// Closed sets the PostgreSQL schema can store (enums TestType / ScheduleStatus).
export type StorableTestType = "Computer-Based" | "Paper-Based";
export type StorableScheduleStatus = "Scheduled" | "Cancelled";

export interface SlotIdKey {
  courseId: string;
  startDate: string;
  endDate: string;
  testType: StorableTestType;
}

export interface StoredTimeSlot extends NormalizedTimeSlot {
  slotId: string;
}

// A create-schedule entry already proven storable (see toStorableSchedule).
export interface NewScheduleRecord {
  courseId: string;
  startDate: string;
  endDate: string;
  name: string;
  testSystem: string;
  testType: StorableTestType;
  status: StorableScheduleStatus;
  timeSlots: StoredTimeSlot[];
  createdAt: Date;
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
