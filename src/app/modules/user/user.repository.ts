import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { runPersistence } from "../../database/persistence-error";
import { runSerializableTransaction, type TransactionClient } from "../../database/transaction";
import { EMAIL_LOCK_SEED, normalizeEmailIdentity } from "../../shared/email-identity";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import { addInt4 } from "./user.validation";
import type {
  AdjustOutcome,
  AllowedUserStatus,
  ApproveOutcome,
  ApprovePatch,
  BlockOutcome,
  GrantOutcome,
  MockGrantEntry,
  ProfileEditRequestRecord,
  StatusOutcome,
  UserFaultHook,
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
  grantMocks(userId: string, entries: MockGrantEntry[]): Promise<GrantOutcome>;
  adjustMock(userId: string, transactionId: unknown, updatedMock: Record<string, unknown>, newMockValue: number): Promise<AdjustOutcome>;
  updateStatus(userId: string, status: AllowedUserStatus): Promise<StatusOutcome>;
  updateBlock(userId: string, isDeleted: boolean): Promise<BlockOutcome>;
  approveProfileEdit(userId: string, patch: ApprovePatch): Promise<ApproveOutcome>;
}

export const USER_TRANSACTION = { maxAttempts: 5, backoffMs: 25, maxWaitMs: 10000, timeoutMs: 15000 } as const;

type RunTransaction = typeof runSerializableTransaction;

class RollbackWith<T> extends Error {
  constructor(readonly outcome: T) {
    super("rollback");
    this.name = "RollbackWith";
  }
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

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function optionalInstant(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function optionalBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function toGrantWire(row: {
  transactionId: string | null;
  mock: number;
  mockType: string | null;
  testType: string | null;
  testSystem: string | null;
  mrValidation: string | null;
  mrValidationExpiry: Date | null;
  emailReminderSent: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}): MockGrantEntry {
  const entry: MockGrantEntry = { mock: row.mock, createdAt: row.createdAt ?? new Date() };
  if (row.transactionId !== null) entry.transactionId = row.transactionId;
  if (row.mockType !== null) entry.mockType = row.mockType;
  if (row.testType !== null) entry.testType = row.testType;
  if (row.testSystem !== null) entry.testSystem = row.testSystem;
  if (row.mrValidation !== null) entry.mrValidation = row.mrValidation;
  if (row.mrValidationExpiry !== null) entry.mrValidationExpiry = row.mrValidationExpiry;
  if (row.emailReminderSent !== null) entry.emailReminderSent = row.emailReminderSent;
  if (row.updatedAt !== null) entry.updatedAt = row.updatedAt;
  return entry;
}

export class PrismaUserRepository implements UserRepository {
  constructor(
    private readonly getClient: () => PrismaClient = getPrismaClient,
    private readonly runTransaction: RunTransaction = runSerializableTransaction,
    private readonly fault: UserFaultHook | undefined = undefined
  ) {}

  private transact<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.runTransaction(fn, USER_TRANSACTION);
  }

  private async hit(point: string): Promise<void> {
    if (this.fault) await this.fault(point);
  }

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

  async grantMocks(userId: string, entries: MockGrantEntry[]): Promise<GrantOutcome> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { kind: "not_found" };
    return runPersistence({ table: "users", operation: "user.grant_mocks" }, async () => {
      try {
        return await this.transact(async (tx) => {
          const users = await tx.$queryRaw<Array<{ mock: number; total_mock: number; name: string; email: string }>>`
            SELECT mock, total_mock, name, email FROM users WHERE id = ${id} FOR UPDATE`;
          const user = users[0];
          if (!user) throw new RollbackWith<GrantOutcome>({ kind: "not_found" });

          const existing = await tx.$queryRaw<Array<{ transaction_id: string | null }>>`
            SELECT transaction_id FROM mock_allocations WHERE user_id = ${id}`;
          const unique = entries.filter(
            (entry) => !existing.some((row) => row.transaction_id === entry.transactionId)
          );
          if (unique.length === 0) throw new RollbackWith<GrantOutcome>({ kind: "all_duplicates" });

          const totalAdd = unique.reduce((sum, entry) => sum + entry.mock, 0);
          if (addInt4(Number(user.mock), totalAdd) === null || addInt4(Number(user.total_mock), totalAdd) === null) {
            throw new RollbackWith<GrantOutcome>({ kind: "overflow" });
          }

          const inserted: MockGrantEntry[] = [];
          for (const entry of unique) {
            const createdAt = entry.createdAt;
            await tx.mockAllocation.create({
              data: {
                id: randomUUID(),
                userId: id,
                transactionId: optionalText(entry.transactionId),
                mock: entry.mock,
                mockType: optionalText(entry.mockType),
                testType: optionalText(entry.testType),
                testSystem: optionalText(entry.testSystem),
                mrValidation: optionalText(entry.mrValidation),
                mrValidationExpiry: optionalInstant(entry.mrValidationExpiry),
                emailReminderSent: optionalBool(entry.emailReminderSent),
                createdAt,
                updatedAt: optionalInstant(entry.updatedAt),
              },
            });
            inserted.push(
              toGrantWire({
                transactionId: optionalText(entry.transactionId),
                mock: entry.mock,
                mockType: optionalText(entry.mockType),
                testType: optionalText(entry.testType),
                testSystem: optionalText(entry.testSystem),
                mrValidation: optionalText(entry.mrValidation),
                mrValidationExpiry: optionalInstant(entry.mrValidationExpiry),
                emailReminderSent: optionalBool(entry.emailReminderSent),
                createdAt,
                updatedAt: optionalInstant(entry.updatedAt),
              })
            );
          }
          await this.hit("grant.after_insert");
          await tx.$executeRaw`
            UPDATE users SET mock = mock + ${totalAdd}, total_mock = total_mock + ${totalAdd} WHERE id = ${id}`;
          return { kind: "granted" as const, addedMocks: inserted, name: user.name, email: user.email };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.outcome;
        throw error;
      }
    });
  }

  async adjustMock(
    userId: string,
    transactionId: unknown,
    updatedMock: Record<string, unknown>,
    newMockValue: number
  ): Promise<AdjustOutcome> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { kind: "not_found" };
    const needle = String(transactionId).trim();
    return runPersistence({ table: "users", operation: "user.adjust_mock" }, async () => {
      try {
        return await this.transact(async (tx) => {
          const users = await tx.$queryRaw<Array<{ mock: number; total_mock: number }>>`
            SELECT mock, total_mock FROM users WHERE id = ${id} FOR UPDATE`;
          if (!users[0]) throw new RollbackWith<AdjustOutcome>({ kind: "not_found" });

          const rows = await tx.$queryRaw<
            Array<{
              id: string;
              transaction_id: string | null;
              mock: number | null;
              mock_type: string | null;
              test_type: string | null;
              test_system: string | null;
              mr_validation: string | null;
              mr_validation_expiry: Date | null;
              email_reminder_sent: boolean | null;
              created_at: Date | null;
              updated_at: Date | null;
            }>
          >`SELECT id, transaction_id, mock, mock_type, test_type, test_system, mr_validation,
                   mr_validation_expiry, email_reminder_sent, created_at, updated_at
             FROM mock_allocations WHERE user_id = ${id}`;
          if (rows.length === 0) throw new RollbackWith<AdjustOutcome>({ kind: "user_or_mocks_not_found" });

          const matches = rows.filter((row) => String(row.transaction_id).trim() === needle);
          if (matches.length === 0) throw new RollbackWith<AdjustOutcome>({ kind: "mock_not_found" });
          if (matches.length > 1) throw new RollbackWith<AdjustOutcome>({ kind: "ambiguous" });
          const current = matches[0]!;

          const prev = Number(current.mock) || 0;
          const delta = newMockValue - prev;
          const newTotal = addInt4(Number(users[0].total_mock), delta);
          if (newTotal === null) throw new RollbackWith<AdjustOutcome>({ kind: "overflow" });
          if (newTotal < 0) throw new RollbackWith<AdjustOutcome>({ kind: "total_below_zero" });
          if (addInt4(Number(users[0].mock), delta) === null) {
            throw new RollbackWith<AdjustOutcome>({ kind: "overflow" });
          }

          const updatedAt = new Date();
          const expiry = optionalInstant(updatedMock.mrValidationExpiry);
          await tx.mockAllocation.update({
            where: { id: current.id },
            data: {
              mock: newMockValue,
              mockType: updatedMock.mockType !== undefined ? optionalText(updatedMock.mockType) : current.mock_type,
              testType: updatedMock.testType !== undefined ? optionalText(updatedMock.testType) : current.test_type,
              testSystem: updatedMock.testSystem !== undefined ? optionalText(updatedMock.testSystem) : current.test_system,
              transactionId:
                updatedMock.transactionId !== undefined ? optionalText(updatedMock.transactionId) : current.transaction_id,
              mrValidation:
                updatedMock.mrValidation !== undefined ? optionalText(updatedMock.mrValidation) : current.mr_validation,
              mrValidationExpiry: expiry ?? current.mr_validation_expiry,
              updatedAt,
            },
          });
          await this.hit("adjust.after_update");
          await tx.$executeRaw`
            UPDATE users SET mock = mock + ${delta}, total_mock = total_mock + ${delta} WHERE id = ${id}`;

          const wire: Record<string, unknown> = {
            ...Object.fromEntries(
              Object.entries({
                transactionId: current.transaction_id,
                mock: current.mock,
                mockType: current.mock_type,
                testType: current.test_type,
                testSystem: current.test_system,
                mrValidation: current.mr_validation,
                mrValidationExpiry: current.mr_validation_expiry,
                emailReminderSent: current.email_reminder_sent,
                createdAt: current.created_at,
                updatedAt: current.updated_at,
              }).filter(([, value]) => value !== null && value !== undefined)
            ),
            ...updatedMock,
            mock: newMockValue,
            updatedAt,
            mrValidationExpiry: expiry ?? current.mr_validation_expiry,
          };
          return { kind: "updated" as const, updatedMock: wire };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.outcome;
        throw error;
      }
    });
  }

  async updateStatus(userId: string, status: AllowedUserStatus): Promise<StatusOutcome> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { kind: "not_found" };
    return runPersistence({ table: "users", operation: "user.update_status" }, async () => {
      try {
        return await this.transact(async (tx) => {
          const users = await tx.$queryRaw<Array<{ name: string; email: string }>>`
            SELECT name, email FROM users WHERE id = ${id} FOR UPDATE`;
          if (!users[0]) throw new RollbackWith<StatusOutcome>({ kind: "not_found" });
          await tx.$executeRaw`
            UPDATE users SET status = ${status}::"UserStatus" WHERE id = ${id}`;
          await this.hit("status.after_update");
          const notifyCompleted = status.toLowerCase() === "completed" ? { name: users[0].name, email: users[0].email } : null;
          return { kind: "updated" as const, notifyCompleted };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.outcome;
        throw error;
      }
    });
  }

  async updateBlock(userId: string, isDeleted: boolean): Promise<BlockOutcome> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { kind: "not_found" };
    return runPersistence({ table: "users", operation: "user.update_block" }, async () => {
      try {
        return await this.transact(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
          if (!locked[0]) throw new RollbackWith<BlockOutcome>({ kind: "not_found" });
          await tx.$executeRaw`UPDATE users SET is_deleted = ${isDeleted} WHERE id = ${id}`;
          await this.hit("block.after_update");
          return { kind: "updated" as const, isDeleted };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.outcome;
        throw error;
      }
    });
  }

  async approveProfileEdit(userId: string, patch: ApprovePatch): Promise<ApproveOutcome> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return { kind: "not_found" };
    return runPersistence({ table: "users", operation: "user.approve_profile_edit" }, async () => {
      try {
        return await this.transact(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
          if (!locked[0]) throw new RollbackWith<ApproveOutcome>({ kind: "not_found" });

          if (patch.email !== undefined) {
            const normalized = normalizeEmailIdentity(patch.email);
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(hashtextextended(${normalized}::text, ${EMAIL_LOCK_SEED}::bigint))`;
            const collisions = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM users WHERE lower(email) = ${normalized} AND id <> ${id} FOR UPDATE`;
            if (collisions.length > 0) throw new RollbackWith<ApproveOutcome>({ kind: "email_in_use" });
          }

          const name = patch.name === undefined ? null : String(patch.name);
          const email = patch.email === undefined ? null : normalizeEmailIdentity(patch.email);
          const contact = patch.phone === undefined ? null : patch.phone === null ? null : String(patch.phone);
          const passport = patch.passportId === undefined ? null : patch.passportId === null ? null : String(patch.passportId);
          const txn = patch.transactionId === undefined ? null : patch.transactionId === null ? null : String(patch.transactionId);
          const setName = patch.name !== undefined;
          const setEmail = patch.email !== undefined;
          const setPhone = patch.phone !== undefined;
          const setPassport = patch.passportId !== undefined;
          const setTxn = patch.transactionId !== undefined;

          const modifiedCount = await tx.$executeRaw`
            UPDATE users SET
              profile_change_request_status = 'default',
              profile_edit_note = NULL,
              updated_at = NOW(),
              name = CASE WHEN ${setName} THEN ${name}::text ELSE name END,
              email = CASE WHEN ${setEmail} THEN ${email}::text ELSE email END,
              contact_no = CASE WHEN ${setPhone} THEN ${contact}::text ELSE contact_no END,
              passport_number = CASE WHEN ${setPassport} THEN ${passport}::text ELSE passport_number END,
              transaction_id = CASE WHEN ${setTxn} THEN ${txn}::text ELSE transaction_id END
            WHERE id = ${id}`;
          await this.hit("approve.after_update");
          if (Number(modifiedCount) === 0) throw new RollbackWith<ApproveOutcome>({ kind: "unchanged" });
          return { kind: "updated" as const };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.outcome;
        throw error;
      }
    });
  }
}
