import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { runPersistence } from "../../database/persistence-error";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import type {
  ProfileEditRequestRecord,
  UserMockEntry,
  UserProfileRecord,
  UserStatusRecord,
  UserSummarySourceRecord,
} from "./user.types";

// Persistence port. Services depend on this interface only.
export interface UserRepository {
  findStatusById(userId: string): Promise<UserStatusRecord | null>;
  findProfileById(userId: string): Promise<UserProfileRecord | null>;
  findSummaryById(userId: string): Promise<UserSummarySourceRecord | null>;
  findProfileEditRequests(): Promise<ProfileEditRequestRecord[]>;
  submitProfileEditRequest(userId: string, note: string): Promise<{ modifiedCount: number }>;
}

type MockRow = {
  transactionId: string | null;
  mock: number | null;
  mockType: string | null;
  mrValidation: string | null;
  mrValidationExpiry: Date | null;
  testSystem: string | null;
  testType: string | null;
  emailReminderSent: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  id: string;
};

// Nullable column => key omitted when NULL (the Mongo "absent" shape).
function setIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function toMockEntry(row: MockRow): UserMockEntry {
  const entry: UserMockEntry = {};
  setIfPresent(entry, "transactionId", row.transactionId);
  setIfPresent(entry, "mock", row.mock);
  setIfPresent(entry, "mockType", row.mockType);
  setIfPresent(entry, "mrValidation", row.mrValidation);
  setIfPresent(entry, "mrValidationExpiry", row.mrValidationExpiry);
  setIfPresent(entry, "testSystem", row.testSystem);
  setIfPresent(entry, "testType", row.testType);
  setIfPresent(entry, "emailReminderSent", row.emailReminderSent);
  setIfPresent(entry, "createdAt", row.createdAt);
  setIfPresent(entry, "updatedAt", row.updatedAt);
  return entry;
}

// F-1: mock_allocations has no ordinal column, so the original mocks[] array
// order cannot be reproduced exactly. Chronological order (createdAt, NULL
// first, id as a stable tie-break) is the closest faithful order; allocations
// with identical createdAt are ordered arbitrarily-but-deterministically.
function orderMocks(rows: MockRow[]): MockRow[] {
  return [...rows].sort((a, b) => {
    const at = a.createdAt ? a.createdAt.getTime() : Number.NEGATIVE_INFINITY;
    const bt = b.createdAt ? b.createdAt.getTime() : Number.NEGATIVE_INFINITY;
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

type UserRow = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  role: string;
  status: string | null;
  isDeleted: boolean;
  dateOfBirth: string | null;
  contactNo: string | null;
  passportNumber: string | null;
  sex: string | null;
  result: unknown;
  mock: number;
  totalMock: number;
  mockType: string | null;
  testSystem: string | null;
  testType: string | null;
  profileChangeRequestStatus: string | null;
  profileEditNote: string | null;
  needPasswordChange: boolean | null;
  passwordChangedAt: Date | null;
  transactionId: string | null;
  teacherLEmail: string | null;
  teacherREmail: string | null;
  teacherWEmail: string | null;
  teacherSEmail: string | null;
  lastTrfEmailAt: Date | null;
  budget: unknown;
};

function toUserRecord(row: UserRow, mocks: MockRow[]): UserSummarySourceRecord {
  const record: UserSummarySourceRecord = { _id: row.id };
  record.name = row.name;
  record.email = row.email;
  record.createdAt = row.createdAt;
  record.updatedAt = row.updatedAt;
  record.role = row.role;
  setIfPresent(record, "status", row.status);
  record.isDeleted = row.isDeleted;
  setIfPresent(record, "dateOfBirth", row.dateOfBirth);
  setIfPresent(record, "contactNo", row.contactNo);
  setIfPresent(record, "passportNumber", row.passportNumber);
  setIfPresent(record, "sex", row.sex);
  setIfPresent(record, "result", row.result);
  record.mock = row.mock;
  record.totalMock = row.totalMock;
  setIfPresent(record, "mockType", row.mockType);
  setIfPresent(record, "testSystem", row.testSystem);
  setIfPresent(record, "testType", row.testType);
  setIfPresent(record, "profileChangeRequestStatus", row.profileChangeRequestStatus);
  setIfPresent(record, "profileEditNote", row.profileEditNote);
  setIfPresent(record, "needPasswordChange", row.needPasswordChange);
  setIfPresent(record, "passwordChangedAt", row.passwordChangedAt);
  setIfPresent(record, "transactionId", row.transactionId);
  setIfPresent(record, "teacherLEmail", row.teacherLEmail);
  setIfPresent(record, "teacherREmail", row.teacherREmail);
  setIfPresent(record, "teacherWEmail", row.teacherWEmail);
  setIfPresent(record, "teacherSEmail", row.teacherSEmail);
  setIfPresent(record, "lastTrfEmailAt", row.lastTrfEmailAt);
  setIfPresent(record, "budget", row.budget);
  if (mocks.length > 0) record.mocks = orderMocks(mocks).map(toMockEntry);
  return record;
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly getClient: () => PrismaClient = getPrismaClient) {}

  // Never selects the password hash into a record that leaves the repository.
  private async loadUser(userId: string): Promise<UserSummarySourceRecord | null> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return null;
    const client = this.getClient();
    const row = await client.user.findUnique({ where: { id }, omit: { password: true, emailVerified: true, image: true } });
    if (!row) return null;
    const mocks = await client.mockAllocation.findMany({ where: { userId: id } });
    return toUserRecord(row as unknown as UserRow, mocks);
  }

  async findStatusById(userId: string): Promise<UserStatusRecord | null> {
    return runPersistence({ table: "users", operation: "user.find_status_by_id" }, () => this.loadUser(userId));
  }

  async findProfileById(userId: string): Promise<UserProfileRecord | null> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return null;
    return runPersistence({ table: "users", operation: "user.find_profile_by_id" }, async () => {
      const row = await this.getClient().user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          contactNo: true,
          passportNumber: true,
          transactionId: true,
          createdAt: true,
          profileChangeRequestStatus: true,
        },
      });
      if (!row) return null;
      const record: UserProfileRecord = { _id: row.id, name: row.name, email: row.email };
      setIfPresent(record as unknown as Record<string, unknown>, "contactNo", row.contactNo);
      setIfPresent(record as unknown as Record<string, unknown>, "passportNumber", row.passportNumber);
      setIfPresent(record as unknown as Record<string, unknown>, "transactionId", row.transactionId);
      record.createdAt = row.createdAt;
      setIfPresent(record as unknown as Record<string, unknown>, "profileChangeRequestStatus", row.profileChangeRequestStatus);
      return record;
    });
  }

  async findSummaryById(userId: string): Promise<UserSummarySourceRecord | null> {
    return runPersistence({ table: "users", operation: "user.find_summary_by_id" }, () => this.loadUser(userId));
  }

  async findProfileEditRequests(): Promise<ProfileEditRequestRecord[]> {
    return runPersistence({ table: "users", operation: "user.find_profile_requests" }, async () => {
      const rows = await this.getClient().user.findMany({
        where: { profileChangeRequestStatus: "requested" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          profileChangeRequestStatus: true,
          profileEditNote: true,
          contactNo: true,
          passportNumber: true,
          transactionId: true,
        },
      });
      return rows.map((row) => {
        const record: ProfileEditRequestRecord = { _id: row.id, name: row.name, email: row.email };
        const bag = record as unknown as Record<string, unknown>;
        setIfPresent(bag, "profileChangeRequestStatus", row.profileChangeRequestStatus);
        setIfPresent(bag, "profileEditNote", row.profileEditNote);
        setIfPresent(bag, "contactNo", row.contactNo);
        setIfPresent(bag, "passportNumber", row.passportNumber);
        setIfPresent(bag, "transactionId", row.transactionId);
        return record;
      });
    });
  }

  // Mongo reported modifiedCount, which is 0 when the document matched but the
  // $set changed nothing ("already requested" with the same note). The raw
  // UPDATE reproduces that exactly, and keeps updated_at untouched like the
  // Mongo $set did.
  async submitProfileEditRequest(userId: string, note: string): Promise<{ modifiedCount: number }> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { modifiedCount: 0 };
    return runPersistence({ table: "users", operation: "user.request_profile_edit" }, async () => {
      const modifiedCount = await this.getClient().$executeRaw`
        UPDATE users
        SET profile_change_request_status = 'requested', profile_edit_note = ${note}::text
        WHERE id = ${id}
          AND (profile_change_request_status IS DISTINCT FROM 'requested'
               OR profile_edit_note IS DISTINCT FROM ${note}::text)`;
      return { modifiedCount };
    });
  }
}
