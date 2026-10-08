// FROZEN REFERENCE: the pre-Stage-15 MongoDB Auth repository, copied from
// src/app/modules/auth/auth.repository.ts at Stage 14 (commit 4052b9c), with only
// the types loosened so it compiles independently of the Stage 15 contracts.
// It exists only so tests/parity/*.parity.ts can run the SAME fixtures through
// real MongoDB semantics and the Stage 15 PostgreSQL repository and compare.
// Never import this from src/. Never "fix" it: it is the legacy contract.
import { ObjectId, type Collection, type Document } from "mongodb";

type Rec = Record<string, unknown>;

export class MongoAuthReference {
  constructor(private readonly usersCollection: Collection<Document>) {}

  async findByEmail(email: string): Promise<Rec | null> {
    return (await this.usersCollection.findOne({ email })) as Rec | null;
  }

  async findByTransactionId(transactionId: unknown): Promise<Document | null> {
    return this.usersCollection.findOne({ transactionId });
  }

  async findById(userId: string): Promise<Rec | null> {
    if (!ObjectId.isValid(userId)) return null;
    return (await this.usersCollection.findOne({ _id: new ObjectId(userId) })) as Rec | null;
  }

  async findAccountStateById(userId: string | undefined): Promise<Rec | null> {
    if (!userId || !ObjectId.isValid(String(userId))) return null;
    return (await this.usersCollection.findOne(
      { _id: new ObjectId(String(userId)) },
      { projection: { isDeleted: 1, status: 1, role: 1, passwordChangedAt: 1 } }
    )) as Rec | null;
  }

  async insertUser(doc: Document): Promise<ObjectId> {
    const result = await this.usersCollection.insertOne(doc);
    return result.insertedId;
  }

  async updatePasswordByUserId(userId: ObjectId, hashedPassword: string, extra: Document = {}): Promise<void> {
    await this.usersCollection.updateOne({ _id: userId }, { $set: { password: hashedPassword, ...extra } });
  }
}