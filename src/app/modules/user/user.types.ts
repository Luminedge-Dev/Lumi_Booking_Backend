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
