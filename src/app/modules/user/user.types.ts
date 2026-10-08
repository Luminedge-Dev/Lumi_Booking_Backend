import type { AuthActor } from "../auth/auth.types";

export type { AuthActor };

// Stage 15: users live in PostgreSQL. _id is the 24-hex string id; only
// modeled columns exist, so legacy-only keys (aliases, results maps, ...)
// are not carried. Nullable columns that are NULL are omitted, matching the
// Mongo "absent" shape callers already handle.
export interface UserStatusRecord extends Record<string, unknown> {
  _id: string;
}

export interface UserProfileRecord {
  _id: string;
  name?: unknown;
  email?: unknown;
  contactNo?: unknown;
  passportNumber?: unknown;
  transactionId?: unknown;
  createdAt?: unknown;
  profileChangeRequestStatus?: unknown;
}

export interface UserProfileDto extends UserProfileRecord {
  phone?: unknown;
  passportId?: unknown;
}

export interface UserMockEntry extends Record<string, unknown> {
  transactionId?: unknown;
  mockType?: unknown;
  testSystem?: unknown;
  testType?: unknown;
  mrValidation?: unknown;
}

export interface UserSummarySourceRecord extends Record<string, unknown> {
  _id: string;
  name?: unknown;
  email?: unknown;
  totalMock?: unknown;
  mock?: unknown;
  transactionId?: unknown;
  mockType?: unknown;
  testSystem?: unknown;
  testType?: unknown;
  mrValidation?: unknown;
  status?: unknown;
  mocks?: UserMockEntry[];
}

export interface UserSummaryDto {
  success: true;
  user: {
    name: unknown;
    email: unknown;
    totalMock: unknown;
    mock: unknown;
    transactionId: unknown;
    mockType: unknown;
    testSystem: unknown;
    testType: unknown;
    mrValidation: unknown;
    status: unknown;
  };
  mocks: UserMockEntry[];
  lastMock: UserMockEntry | null;
}

export interface ProfileEditRequestRecord {
  _id: string;
  name?: unknown;
  email?: unknown;
  profileChangeRequestStatus?: unknown;
  profileEditNote?: unknown;
  contactNo?: unknown;
  passportNumber?: unknown;
  transactionId?: unknown;
}

export interface ParsedProfileEditInput {
  userId: string;
  note: unknown;
}

export class UserHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.message === "string" ? body.message : "UserHttpError");
    this.name = "UserHttpError";
  }
}

export const ALLOWED_USER_STATUSES = ["active", "checked", "completed", "blocked"] as const;
export type AllowedUserStatus = (typeof ALLOWED_USER_STATUSES)[number];

export const CONTRACTED_ALLOCATION_FIELDS = [
  "transactionId",
  "mock",
  "mockType",
  "testType",
  "testSystem",
  "mrValidation",
  "mrValidationExpiry",
  "createdAt",
  "updatedAt",
  "emailReminderSent",
] as const;

export interface MockGrantEntry {
  transactionId?: unknown;
  mock: number;
  mockType?: unknown;
  testType?: unknown;
  testSystem?: unknown;
  mrValidation?: unknown;
  mrValidationExpiry?: unknown;
  createdAt: Date;
  updatedAt?: unknown;
  emailReminderSent?: unknown;
}

export type GrantOutcome =
  | { kind: "not_found" }
  | { kind: "all_duplicates" }
  | { kind: "overflow" }
  | { kind: "granted"; addedMocks: MockGrantEntry[]; name: string; email: string };

export type AdjustOutcome =
  | { kind: "not_found" }
  | { kind: "user_or_mocks_not_found" }
  | { kind: "mock_not_found" }
  | { kind: "ambiguous" }
  | { kind: "total_below_zero" }
  | { kind: "overflow" }
  | { kind: "updated"; updatedMock: Record<string, unknown> };

export type StatusOutcome =
  | { kind: "not_found" }
  | { kind: "updated"; notifyCompleted: { name: string; email: string } | null };

export type BlockOutcome = { kind: "not_found" } | { kind: "updated"; isDeleted: boolean };

export type ApproveOutcome = { kind: "not_found" } | { kind: "unchanged" } | { kind: "email_in_use" } | { kind: "updated" };

export interface ApprovePatch {
  name?: unknown;
  email?: string;
  phone?: unknown;
  passportId?: unknown;
  transactionId?: unknown;
}

export type UserFaultHook = (point: string) => void | Promise<void>;
