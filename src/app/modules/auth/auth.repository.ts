import { Prisma } from "../../../generated/prisma/client.js";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { runPersistence } from "../../database/persistence-error";
import { toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import { EMAIL_LOCK_SEED, normalizeEmailIdentity } from "../../shared/email-identity";
import { UserEmailConflictError } from "./auth.types";
import type { AuthAccountStateProjection, AuthUserRecord, NewUserRecord, PasswordUpdateExtra } from "./auth.types";

// Persistence port. Services depend on this interface only.
export interface AuthRepository {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findByTransactionId(transactionId: unknown): Promise<{ _id: string } | null>;
  findById(userId: string): Promise<AuthUserRecord | null>;
  findAccountStateById(userId: string | undefined): Promise<AuthAccountStateProjection | null>;
  insertUser(doc: NewUserRecord): Promise<string>;
  updatePasswordByUserId(userId: string, hashedPassword: string, extra?: PasswordUpdateExtra): Promise<void>;
}

type AuthRow = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  status: string | null;
  isDeleted: boolean;
  passwordChangedAt: Date | null;
  needPasswordChange: boolean | null;
};

function toAuthUser(row: AuthRow): AuthUserRecord {
  const record: AuthUserRecord = {
    _id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    role: row.role,
    isDeleted: row.isDeleted,
  };
  if (row.status !== null) record.status = row.status;
  if (row.passwordChangedAt !== null) record.passwordChangedAt = row.passwordChangedAt;
  if (row.needPasswordChange !== null) record.needPasswordChange = row.needPasswordChange;
  return record;
}

const AUTH_SELECT = {
  id: true,
  name: true,
  email: true,
  password: true,
  role: true,
  status: true,
  isDeleted: true,
  passwordChangedAt: true,
  needPasswordChange: true,
} as const;

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly getClient: () => PrismaClient = getPrismaClient) {}

  // Exact-string email match, like the Mongo {email} filter. Stage 14
  // quarantined users are simply absent: no fallback, no repair.
  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    return runPersistence({ table: "users", operation: "auth.find_by_email" }, async () => {
      const row = await this.getClient().user.findFirst({ where: { email }, orderBy: { id: "asc" }, select: AUTH_SELECT });
      return row ? toAuthUser(row) : null;
    });
  }

  // Mongo semantics: findOne({transactionId}) with an undefined/null value
  // matches any user whose transactionId is null OR missing; a string matches
  // exactly. Any other BSON type could only ever match a same-typed stored
  // value, and PostgreSQL stores text only, so it matches nothing.
  async findByTransactionId(transactionId: unknown): Promise<{ _id: string } | null> {
    if (transactionId !== undefined && transactionId !== null && typeof transactionId !== "string") return null;
    return runPersistence({ table: "users", operation: "auth.find_by_transaction_id" }, async () => {
      const row = await this.getClient().user.findFirst({
        where: { transactionId: transactionId === undefined || transactionId === null ? null : transactionId },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      return row ? { _id: row.id } : null;
    });
  }

  async findById(userId: string): Promise<AuthUserRecord | null> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return null;
    return runPersistence({ table: "users", operation: "auth.find_by_id" }, async () => {
      const row = await this.getClient().user.findUnique({ where: { id }, select: AUTH_SELECT });
      return row ? toAuthUser(row) : null;
    });
  }

  async findAccountStateById(userId: string | undefined): Promise<AuthAccountStateProjection | null> {
    const id = userId ? toCanonicalObjectIdHex(String(userId)) : null;
    if (!id) return null;
    return runPersistence({ table: "users", operation: "auth.find_account_state" }, async () => {
      const row = await this.getClient().user.findUnique({
        where: { id },
        select: { isDeleted: true, status: true, role: true, passwordChangedAt: true },
      });
      if (!row) return null;
      const state: AuthAccountStateProjection = { isDeleted: row.isDeleted, role: row.role };
      if (row.status !== null) state.status = row.status;
      if (row.passwordChangedAt !== null) state.passwordChangedAt = row.passwordChangedAt;
      return state;
    });
  }

  // PostgreSQL has no UNIQUE(email) (Stage 13 schema is consumed as-is, and
  // Stage 14 found case-insensitive duplicates it must not repair). The Mongo
  // unique index is reproduced for NEW registrations only: inserts of the same
  // exact email are serialized with a transaction-scoped advisory lock and the
  // existence check runs inside the lock.
  async insertUser(doc: NewUserRecord): Promise<string> {
    return runPersistence({ table: "users", operation: "auth.insert_user" }, async () => {
      await this.getClient().$transaction(async (tx) => {
        const lockKey = normalizeEmailIdentity(doc.email);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, ${EMAIL_LOCK_SEED}::bigint))`;
        const existing = await tx.user.findFirst({ where: { email: doc.email }, select: { id: true } });
        if (existing) throw new UserEmailConflictError();
        await tx.user.create({
          data: {
            id: doc._id,
            name: doc.name,
            email: doc.email,
            password: doc.password,
            role: doc.role,
            status: doc.status,
            isDeleted: doc.isDeleted,
            contactNo: doc.contactNo ?? null,
            passportNumber: doc.passportNumber ?? null,
            sex: doc.sex ?? null,
            dateOfBirth: doc.dateOfBirth ?? null,
            transactionId: doc.transactionId ?? null,
            mock: doc.mock,
            totalMock: doc.totalMock,
            result: doc.result === null ? Prisma.DbNull : (doc.result as Prisma.InputJsonValue),
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          },
        });
      });
      return doc._id;
    });
  }

  // Raw UPDATE so updated_at is left alone, exactly like the Mongo $set that
  // only touched password / passwordChangedAt / needPasswordChange. A missing
  // user is a no-op (Mongo updateOne matched nothing).
  async updatePasswordByUserId(userId: string, hashedPassword: string, extra: PasswordUpdateExtra = {}): Promise<void> {
    const id = toCanonicalObjectIdHex(userId);
    if (!id) return;
    await runPersistence({ table: "users", operation: "auth.update_password" }, async () => {
      const client = this.getClient();
      const changedAt = extra.passwordChangedAt;
      if (extra.needPasswordChange !== undefined && changedAt) {
        await client.$executeRaw`UPDATE users SET password = ${hashedPassword}, password_changed_at = ${changedAt}::timestamptz, need_password_change = ${extra.needPasswordChange}::boolean WHERE id = ${id}`;
      } else if (changedAt) {
        await client.$executeRaw`UPDATE users SET password = ${hashedPassword}, password_changed_at = ${changedAt}::timestamptz WHERE id = ${id}`;
      } else if (extra.needPasswordChange !== undefined) {
        await client.$executeRaw`UPDATE users SET password = ${hashedPassword}, need_password_change = ${extra.needPasswordChange}::boolean WHERE id = ${id}`;
      } else {
        await client.$executeRaw`UPDATE users SET password = ${hashedPassword} WHERE id = ${id}`;
      }
    });
  }
}
