import type {
  ProfileEditRequestRecord,
  UserMockEntry,
  UserProfileDto,
  UserProfileRecord,
  UserStatusRecord,
  UserSummaryDto,
  UserSummarySourceRecord,
} from "./user.types";

export function toUserStatusResponse(record: UserStatusRecord | null): { user: UserStatusRecord | null } {
  return { user: record };
}

export function toProfileDto(record: UserProfileRecord): UserProfileDto {
  return {
    ...record,
    phone: record.contactNo,
    passportId: record.passportNumber,
  };
}

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
