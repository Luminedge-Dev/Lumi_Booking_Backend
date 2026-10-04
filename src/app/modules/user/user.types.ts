import type { ObjectId } from "mongodb";
import type { AuthActor } from "../auth/auth.types";

export type { AuthActor };

// /user/status's legacy contract is the full document minus password (no
// further projection) -- this type is intentionally open (index signature),
// not an enumerated DTO, so any field a document carries (including either
// dateOfBirth/dateofbirth key) survives mapping untouched. password is
// excluded at the query level (repository projection), not by this type.
export interface UserStatusRecord extends Record<string, unknown> {
  _id: ObjectId;
}

// Narrow and explicit, matching routes/user.routes.js:146-176's own fixed
// projection exactly -- legacy already narrows this response, so the native
// DTO stays narrow too.
export interface UserProfileRecord {
  _id: ObjectId;
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

// Full document (mocks[] + root fallback fields) -- the summary DTO below
// narrows it, matching routes/user.routes.js:545-584's own explicit
// response-building exactly.
export interface UserSummarySourceRecord extends Record<string, unknown> {
  _id: ObjectId;
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
  _id: ObjectId;
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
  // Normalized `note || ""` at parse time: any truthy JSON value is preserved
  // unchanged (legacy parity), falsy/missing maps to "". Typed unknown (not
  // string) so validation never narrows what legacy accepts.
  note: unknown;
}
