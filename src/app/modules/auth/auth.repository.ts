import { ObjectId, type Collection, type Document } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import type { AuthAccountStateProjection, AuthUserRecord } from "./auth.types";

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
