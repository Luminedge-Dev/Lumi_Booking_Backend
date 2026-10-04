import { ObjectId, type Collection, type Document } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import type { AuthAccountStateProjection, AuthUserRecord } from "./auth.types";

// The only file in this module allowed to touch MongoDB directly
// (AGENTS.md's layer-responsibility rules: repositories own collection
// access, services/controllers do not). Deliberately narrow: this is Auth's
// own small projection (auth.types.ts's AuthUserRecord), not the Stage 6
// canonical User model -- Stage 8 owns the full User repository.
export class AuthRepository {
  constructor(private readonly usersCollection: Collection<Document>) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const doc = await measureDatabaseOperation({ collection: "users", operation: "auth.find_by_email" }, () =>
      this.usersCollection.findOne({ email })
    );
    return doc as AuthUserRecord | null;
  }

  async findByTransactionId(transactionId: unknown): Promise<Document | null> {
    return measureDatabaseOperation({ collection: "users", operation: "auth.find_by_transaction_id" }, () =>
      this.usersCollection.findOne({ transactionId })
    );
  }

  async findById(userId: string): Promise<AuthUserRecord | null> {
    if (!ObjectId.isValid(userId)) return null;
    const doc = await measureDatabaseOperation({ collection: "users", operation: "auth.find_by_id" }, () =>
      this.usersCollection.findOne({ _id: new ObjectId(userId) })
    );
    return doc as AuthUserRecord | null;
  }

  // Mirrors middleware/auth.js's checkAccountState() projection exactly:
  // { isDeleted, status, role, passwordChangedAt }. Returns null (not an
  // error) when userId is missing/invalid -- the caller (auth.middleware.ts)
  // is responsible for treating that as "skip the live check", matching the
  // legacy behavior documented in auth.types.ts's AuthActor comment.
  async findAccountStateById(userId: string | undefined): Promise<AuthAccountStateProjection | null> {
    if (!userId || !ObjectId.isValid(String(userId))) return null;
    const doc = await measureDatabaseOperation({ collection: "users", operation: "auth.find_account_state" }, () =>
      this.usersCollection.findOne(
        { _id: new ObjectId(String(userId)) },
        { projection: { isDeleted: 1, status: 1, role: 1, passwordChangedAt: 1 } }
      )
    );
    return doc as AuthAccountStateProjection | null;
  }

  async insertUser(doc: Document): Promise<ObjectId> {
    const result = await measureDatabaseOperation({ collection: "users", operation: "auth.insert_user" }, () =>
      this.usersCollection.insertOne(doc)
    );
    return result.insertedId;
  }

  async updatePasswordByUserId(
    userId: ObjectId,
    hashedPassword: string,
    extra: Document = {}
  ): Promise<void> {
    await measureDatabaseOperation({ collection: "users", operation: "auth.update_password" }, () =>
      this.usersCollection.updateOne(
        { _id: userId },
        { $set: { password: hashedPassword, ...extra } }
      )
    );
  }
}
