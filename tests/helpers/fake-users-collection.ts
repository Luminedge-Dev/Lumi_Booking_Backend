import { ObjectId } from "mongodb";

export interface FakeDoc extends Record<string, unknown> {
  _id: ObjectId;
}

// Minimal in-memory fake standing in for the real MongoDB `users` collection
// -- enough Mongo-shaped behavior (findOne/insertOne/updateOne, E11000 on a
// duplicate email) for routes/auth.routes.js's AND the native Auth module's
// repository's exact code paths, nothing more. Shared by the legacy
// characterization tests and the native-module parity tests so both exercise
// identical fake data semantics.
export class FakeUsersCollection {
  constructor(private docs: FakeDoc[] = []) {}

  private matches(doc: FakeDoc, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      if (value instanceof ObjectId) {
        const docValue = doc[key];
        return docValue instanceof ObjectId && docValue.equals(value);
      }
      return doc[key] === value;
    });
  }

  async findOne(filter: Record<string, unknown>): Promise<FakeDoc | null> {
    return this.docs.find((d) => this.matches(d, filter)) ?? null;
  }

  async insertOne(doc: FakeDoc): Promise<{ insertedId: ObjectId }> {
    if (typeof doc.email === "string" && this.docs.some((d) => d.email === doc.email)) {
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    }
    this.docs.push(doc);
    return { insertedId: doc._id };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> }
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const doc = this.docs.find((d) => this.matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  find(): FakeDoc[] {
    return this.docs;
  }

  addDoc(doc: FakeDoc): void {
    this.docs.push(doc);
  }
}
