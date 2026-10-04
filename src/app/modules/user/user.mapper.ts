import type {
  ProfileEditRequestRecord,
  UserMockEntry,
  UserProfileDto,
  UserProfileRecord,
  UserStatusRecord,
  UserSummaryDto,
  UserSummarySourceRecord,
} from "./user.types";

// Owns ALL response-shape transformation for this module -- see Stage 8
// plan ss6: the service orchestrates, this file owns the actual mapping, so
// mapper unit tests exercise the real logic.

// Full-document-minus-password PASSTHROUGH -- routes/user.routes.js:129-144
// has no projection beyond excluding password, so this is not an enumerated
// DTO. Whichever fields a document carries (dateOfBirth, dateofbirth, or
// anything else) pass straight through unchanged, matching legacy exactly.
export function toUserStatusResponse(record: UserStatusRecord | null): { user: UserStatusRecord | null } {
  return { user: record };
}

// routes/user.routes.js:168-171's exact alias behavior: contactNo also
// exposed as `phone`, passportNumber also exposed as `passportId`.
export function toProfileDto(record: UserProfileRecord): UserProfileDto {
  return {
    ...record,
    phone: record.contactNo,
    passportId: record.passportNumber,
  };
}

// routes/user.routes.js:558-577's exact fallback chain:
// lastMock?.field || root.field || "N/A" (transactionId/mockType/testSystem/
// testType/mrValidation), name/email default to "Unknown User"/"No Email",
// totalMock/mock/status use ?? so a real 0 survives (never falsy-coalesced
// to "N/A").
export function toUserSummaryDto(record: UserSummarySourceRecord): UserSummaryDto {
  const mocks: UserMockEntry[] = Array.isArray(record.mocks) ? record.mocks : [];
  const lastMock = mocks.length > 0 ? mocks[mocks.length - 1] : null;

  return {
    success: true,
    user: {
      name: record.name ?? "Unknown User",
      email: record.email ?? "No Email",
      totalMock: record.totalMock ?? 0,
      mock: record.mock ?? 0,
      transactionId: lastMock?.transactionId || record.transactionId || "N/A",
      mockType: lastMock?.mockType || record.mockType || "N/A",
      testSystem: lastMock?.testSystem || record.testSystem || "N/A",
      testType: lastMock?.testType || record.testType || "N/A",
      mrValidation: lastMock?.mrValidation || record.mrValidation || "N/A",
      status: record.status ?? "N/A",
    },
    mocks,
    lastMock,
  };
}

export function toProfileEditRequestDto(record: ProfileEditRequestRecord): ProfileEditRequestRecord {
  return { ...record };
}
