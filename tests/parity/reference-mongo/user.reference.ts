// FROZEN REFERENCE: the pre-Stage-15 MongoDB User repository, copied from
// src/app/modules/user/user.repository.ts at Stage 14 (commit 4052b9c), with only
// the types loosened so it compiles independently of the Stage 15 contracts.
// It exists only so tests/parity/*.parity.ts can run the SAME fixtures through
// real MongoDB semantics and the Stage 15 PostgreSQL repository and compare.
// Never import this from src/. Never "fix" it: it is the legacy contract.
import { ObjectId, type Collection, type Document } from "mongodb";

type Rec = Record<string, unknown>;

export class MongoUserReference {
  constructor(private readonly usersCollection: Collection<Document>) {}

  async findStatusById(userId: string): Promise<Rec | null> {
    const doc = await this.usersCollection.findOne({ _id: new ObjectId(userId) }, { projection: { password: 0 } });
    return doc as unknown as Rec | null;
  }

  async findProfileById(userId: string): Promise<Rec | null> {
    const doc = await this.usersCollection.findOne(
      { _id: new ObjectId(userId) },
      {
        projection: {
          name: 1,
          email: 1,
          contactNo: 1,
          passportNumber: 1,
          transactionId: 1,
          createdAt: 1,
          profileChangeRequestStatus: 1,
        },
      }
    );
    return doc as unknown as Rec | null;
  }

  async findSummaryById(userId: string): Promise<Rec | null> {
    const doc = await this.usersCollection.findOne({ _id: new ObjectId(userId) });
    return doc as unknown as Rec | null;
  }

  async findProfileEditRequests(): Promise<Rec[]> {
    const docs = await this.usersCollection
      .find({ profileChangeRequestStatus: "requested" })
      .project({
        _id: 1,
        name: 1,
        email: 1,
        profileChangeRequestStatus: 1,
        profileEditNote: 1,
        contactNo: 1,
        passportNumber: 1,
        transactionId: 1,
      })
      .toArray();
    return docs as unknown as Rec[];
  }

  async submitProfileEditRequest(userId: string, note: unknown): Promise<{ modifiedCount: number }> {
    const result = await this.usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { profileChangeRequestStatus: "requested", profileEditNote: note } }
    );
    return { modifiedCount: result.modifiedCount };
  }
}