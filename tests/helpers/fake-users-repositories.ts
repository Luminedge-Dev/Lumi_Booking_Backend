// Test-only in-memory Auth/User repositories backed by the Mongo-shaped
// FakeUsersCollection that most HTTP-level tests already seed. They behave like
// the Stage 15 PostgreSQL repositories as seen ABOVE the repository boundary:
// string hex ids, only modeled columns, nullable columns absent, exact-email
// match, transactionId null-matching, modifiedCount semantics. They are NOT
// evidence of PostgreSQL behavior (see tests/postgres + tests/parity).
import { ObjectId } from "mongodb";
import type { AuthRepository } from "../../src/app/modules/auth/auth.repository";
import { UserEmailConflictError } from "../../src/app/modules/auth/auth.types";
import type {
  AuthAccountStateProjection,
  AuthUserRecord,
  NewUserRecord,
  PasswordUpdateExtra,
} from "../../src/app/modules/auth/auth.types";
import type { UserRepository } from "../../src/app/modules/user/user.repository";
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
  UserProfileRecord,
  UserStatusRecord,
  UserSummarySourceRecord,
} from "../../src/app/modules/user/user.types";
import { normalizeEmailIdentity } from "../../src/app/shared/email-identity";
import { toCanonicalObjectIdHex } from "../../src/app/shared/utils/object-id";
import { addInt4 } from "../../src/app/modules/user/user.validation";
import type { FakeDoc, FakeUsersCollection } from "./fake-users-collection";

// Columns of the Stage 13 users table that the User module surfaces.
const USER_COLUMNS = [
  "name", "email", "createdAt", "updatedAt", "role", "status", "isDeleted", "dateOfBirth", "contactNo",
  "passportNumber", "sex", "result", "mock", "totalMock", "mockType", "testSystem", "testType",
  "profileChangeRequestStatus", "profileEditNote", "needPasswordChange", "passwordChangedAt", "transactionId",
  "teacherLEmail", "teacherREmail", "teacherWEmail", "teacherSEmail", "lastTrfEmailAt", "budget",
] as const;

function allDocs(users: FakeUsersCollection): FakeDoc[] {
  return users.find();
}

function findDoc(users: FakeUsersCollection, userId: string | undefined): FakeDoc | undefined {
  const hex = userId ? toCanonicalObjectIdHex(String(userId)) : null;
  if (!hex) return undefined;
  return allDocs(users).find((d) => d._id.toHexString() === hex);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function toAuthUser(doc: FakeDoc): AuthUserRecord {
  const record: AuthUserRecord = {
    _id: doc._id.toHexString(),
    email: doc.email as string,
    password: doc.password as string,
    role: doc.role as string,
  };
  if (present(doc.name)) record.name = doc.name as string;
  if (present(doc.status)) record.status = doc.status as string;
  record.isDeleted = doc.isDeleted === true;
  if (present(doc.passwordChangedAt)) record.passwordChangedAt = doc.passwordChangedAt as Date;
  if (present(doc.needPasswordChange)) record.needPasswordChange = doc.needPasswordChange as boolean;
  return record;
}

export class FakeUsersAuthRepository implements AuthRepository {
  constructor(private readonly users: FakeUsersCollection) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const doc = allDocs(this.users).find((d) => d.email === email);
    return doc ? toAuthUser(doc) : null;
  }

  async findByTransactionId(transactionId: unknown): Promise<{ _id: string } | null> {
    if (present(transactionId) && typeof transactionId !== "string") return null;
    const doc = allDocs(this.users).find((d) =>
      present(transactionId) ? d.transactionId === transactionId : !present(d.transactionId)
    );
    return doc ? { _id: doc._id.toHexString() } : null;
  }

  async findById(userId: string): Promise<AuthUserRecord | null> {
    const doc = findDoc(this.users, userId);
    return doc ? toAuthUser(doc) : null;
  }

  async findAccountStateById(userId: string | undefined): Promise<AuthAccountStateProjection | null> {
    const doc = findDoc(this.users, userId);
    if (!doc) return null;
    const state: AuthAccountStateProjection = { isDeleted: doc.isDeleted === true, role: doc.role as string };
    if (present(doc.status)) state.status = doc.status as string;
    if (present(doc.passwordChangedAt)) state.passwordChangedAt = doc.passwordChangedAt as Date;
    return state;
  }

  async insertUser(doc: NewUserRecord): Promise<string> {
    try {
      await this.users.insertOne({ ...doc, _id: new ObjectId(doc._id) } as unknown as FakeDoc);
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) throw new UserEmailConflictError();
      throw error;
    }
    return doc._id;
  }

  async updatePasswordByUserId(userId: string, hashedPassword: string, extra: PasswordUpdateExtra = {}): Promise<void> {
    const doc = findDoc(this.users, userId);
    if (!doc) return;
    await this.users.updateOne({ _id: doc._id }, { $set: { password: hashedPassword, ...extra } });
  }
}

function toUserRecord(doc: FakeDoc): UserSummarySourceRecord {
  const record: UserSummarySourceRecord = { _id: doc._id.toHexString() };
  for (const column of USER_COLUMNS) {
    if (present(doc[column])) record[column] = doc[column];
  }
  if (Array.isArray(doc.mocks) && doc.mocks.length > 0) record.mocks = doc.mocks as UserSummarySourceRecord["mocks"];
  return record;
}

export class FakeUsersUserRepository implements UserRepository {
  constructor(private readonly users: FakeUsersCollection) {}

  async findStatusById(userId: string): Promise<UserStatusRecord | null> {
    const doc = findDoc(this.users, userId);
    return doc ? toUserRecord(doc) : null;
  }

  async findProfileById(userId: string): Promise<UserProfileRecord | null> {
    const doc = findDoc(this.users, userId);
    if (!doc) return null;
    const full = toUserRecord(doc);
    const record: UserProfileRecord = { _id: full._id, name: full.name, email: full.email };
    for (const key of ["contactNo", "passportNumber", "transactionId", "createdAt", "profileChangeRequestStatus"] as const) {
      if (present(full[key])) (record as unknown as Record<string, unknown>)[key] = full[key];
    }
    return record;
  }

  async findSummaryById(userId: string): Promise<UserSummarySourceRecord | null> {
    const doc = findDoc(this.users, userId);
    return doc ? toUserRecord(doc) : null;
  }

  async findProfileEditRequests(): Promise<ProfileEditRequestRecord[]> {
    return allDocs(this.users)
      .filter((d) => d.profileChangeRequestStatus === "requested")
      .sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()))
      .map((d) => {
        const full = toUserRecord(d);
        const record: ProfileEditRequestRecord = { _id: full._id, name: full.name, email: full.email };
        for (const key of ["profileChangeRequestStatus", "profileEditNote", "contactNo", "passportNumber", "transactionId"] as const) {
          if (present(full[key])) (record as unknown as Record<string, unknown>)[key] = full[key];
        }
        return record;
      });
  }

  async submitProfileEditRequest(userId: string, note: string): Promise<{ modifiedCount: number }> {
    const doc = findDoc(this.users, userId);
    if (!doc) return { modifiedCount: 0 };
    if (doc.profileChangeRequestStatus === "requested" && doc.profileEditNote === note) return { modifiedCount: 0 };
    await this.users.updateOne({ _id: doc._id }, { $set: { profileChangeRequestStatus: "requested", profileEditNote: note } });
    return { modifiedCount: 1 };
  }

  async grantMocks(userId: string, entries: MockGrantEntry[]): Promise<GrantOutcome> {
    const doc = findDoc(this.users, userId);
    if (!doc) return { kind: "not_found" };
    const mocks = Array.isArray(doc.mocks) ? (doc.mocks as Array<Record<string, unknown>>) : [];
    const unique = entries.filter((entry) => !mocks.some((existing) => existing.transactionId === entry.transactionId));
    if (unique.length === 0) return { kind: "all_duplicates" };
    const totalAdd = unique.reduce((sum, entry) => sum + entry.mock, 0);
    if (addInt4(Number(doc.mock) || 0, totalAdd) === null || addInt4(Number(doc.totalMock) || 0, totalAdd) === null) {
      return { kind: "overflow" };
    }
    await this.users.updateOne(
      { _id: doc._id },
      { $push: { mocks: { $each: unique } }, $inc: { mock: totalAdd, totalMock: totalAdd } }
    );
    return { kind: "granted", addedMocks: unique, name: String(doc.name ?? ""), email: String(doc.email ?? "") };
  }

  async adjustMock(
    userId: string,
    transactionId: unknown,
    updatedMock: Record<string, unknown>,
    newMockValue: number
  ): Promise<AdjustOutcome> {
    const doc = findDoc(this.users, userId);
    if (!doc || !Array.isArray(doc.mocks)) return { kind: "user_or_mocks_not_found" };
    const mocks = doc.mocks as Array<Record<string, unknown>>;
    const needle = String(transactionId).trim();
    const matches = mocks.filter((row) => String(row.transactionId).trim() === needle);
    if (matches.length === 0) return { kind: "mock_not_found" };
    if (matches.length > 1) return { kind: "ambiguous" };
    const index = mocks.findIndex((row) => String(row.transactionId).trim() === needle);
    const prev = Number(mocks[index]?.mock) || 0;
    const delta = newMockValue - prev;
    const newTotal = addInt4(Number(doc.totalMock) || 0, delta);
    if (newTotal === null) return { kind: "overflow" };
    if (newTotal < 0) return { kind: "total_below_zero" };
    if (addInt4(Number(doc.mock) || 0, delta) === null) return { kind: "overflow" };
    const next = { ...mocks[index], ...updatedMock, mock: newMockValue };
    const copy = [...mocks];
    copy[index] = next;
    await this.users.updateOne({ _id: doc._id }, { $set: { mocks: copy }, $inc: { mock: delta, totalMock: delta } });
    return { kind: "updated", updatedMock: next };
  }

  async updateStatus(userId: string, status: AllowedUserStatus): Promise<StatusOutcome> {
    const doc = findDoc(this.users, userId);
    if (!doc) return { kind: "not_found" };
    await this.users.updateOne({ _id: doc._id }, { $set: { status } });
    const notifyCompleted =
      status.toLowerCase() === "completed" ? { name: String(doc.name ?? ""), email: String(doc.email ?? "") } : null;
    return { kind: "updated", notifyCompleted };
  }

  async updateBlock(userId: string, isDeleted: boolean): Promise<BlockOutcome> {
    const doc = findDoc(this.users, userId);
    if (!doc) return { kind: "not_found" };
    await this.users.updateOne({ _id: doc._id }, { $set: { isDeleted } });
    return { kind: "updated", isDeleted };
  }

  async approveProfileEdit(userId: string, patch: ApprovePatch): Promise<ApproveOutcome> {
    const doc = findDoc(this.users, userId);
    if (!doc) return { kind: "not_found" };
    if (patch.email !== undefined) {
      const normalized = normalizeEmailIdentity(patch.email);
      const collision = allDocs(this.users).some(
        (other) => other._id.toHexString() !== doc._id.toHexString() && normalizeEmailIdentity(String(other.email ?? "")) === normalized
      );
      if (collision) return { kind: "email_in_use" };
    }
    const $set: Record<string, unknown> = {
      profileChangeRequestStatus: "default",
      profileEditNote: null,
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.email !== undefined) $set.email = normalizeEmailIdentity(patch.email);
    if (patch.phone !== undefined) $set.contactNo = patch.phone;
    if (patch.passportId !== undefined) $set.passportNumber = patch.passportId;
    if (patch.transactionId !== undefined) $set.transactionId = patch.transactionId;
    await this.users.updateOne({ _id: doc._id }, { $set });
    return { kind: "updated" };
  }
}

export function usersBackedRepositories(users: FakeUsersCollection): { auth: AuthRepository; user: UserRepository } {
  return { auth: new FakeUsersAuthRepository(users), user: new FakeUsersUserRepository(users) };
}
