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

  // Minimal subset of real Mongo projection semantics -- enough for Stage 8's
  // User module (which uses {password:0} exclusion and {field:1,...}
  // inclusion, never mixed). Returns a shallow copy either way so callers
  // can't accidentally mutate the stored doc through a read.
  private applyProjection(doc: FakeDoc, projection?: Record<string, 0 | 1>): FakeDoc {
    if (!projection) return { ...doc };
    const keys = Object.keys(projection);
    if (keys.some((k) => projection[k] === 0)) {
      const result = { ...doc } as Record<string, unknown>;
      for (const k of keys) if (projection[k] === 0) delete result[k];
      return result as FakeDoc;
    }
    const result: Record<string, unknown> = {};
    if (projection._id !== 0) result._id = doc._id;
    for (const k of keys) if (projection[k] === 1 && k in doc) result[k] = doc[k];
    return result as FakeDoc;
  }

  async findOne(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, 0 | 1> }
  ): Promise<FakeDoc | null> {
    const doc = this.docs.find((d) => this.matches(d, filter));
    if (!doc) return null;
    return this.applyProjection(doc, options?.projection);
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

  // Zero-arg form (existing, unchanged behavior): returns the raw backing
  // array directly, for the many existing call sites doing `.find()[0]`.
  // With-filter form (Stage 8 addition, needed for GET /users/with-
  // profile-request's real `.find(filter).project(proj).toArray()` chain):
  // returns a cursor-shaped object instead of a plain array.
  // Supports both real Mongo cursor call shapes used by routes/user.routes.js:
  // `.find(filter).project(proj).toArray()` (/users/with-profile-request) and
  // `.find(filter, {projection}).toArray()` (/user/all, /admin/users).
  find(): FakeDoc[];
  find(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, 0 | 1> }
  ): {
    project: (projection: Record<string, 0 | 1>) => { toArray: () => Promise<FakeDoc[]> };
    toArray: () => Promise<FakeDoc[]>;
  };
  find(
    filter?: Record<string, unknown>,
    options?: { projection?: Record<string, 0 | 1> }
  ):
    | FakeDoc[]
    | {
        project: (projection: Record<string, 0 | 1>) => { toArray: () => Promise<FakeDoc[]> };
        toArray: () => Promise<FakeDoc[]>;
      } {
    if (filter === undefined) return this.docs;
    const matched = this.docs.filter((d) => this.matches(d, filter));
    return {
      project: (projection: Record<string, 0 | 1>) => ({
        toArray: async () => matched.map((d) => this.applyProjection(d, projection)),
      }),
      toArray: async () => matched.map((d) => this.applyProjection(d, options?.projection)),
    };
  }

  addDoc(doc: FakeDoc): void {
    this.docs.push(doc);
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    return this.docs.filter((d) => this.matches(d, filter)).length;
  }
}
