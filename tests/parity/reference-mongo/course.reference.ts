// FROZEN REFERENCE: the pre-Stage-15 MongoDB Course repository, copied from
// src/app/modules/course/course.repository.ts at Stage 14 (commit 4052b9c).
// It exists only so tests/parity/*.parity.ts can run the SAME fixtures through
// real MongoDB semantics and the Stage 15 PostgreSQL repository and compare.
// Never import this from src/. Never "fix" it: it is the legacy contract.
import type { Collection, Document } from "mongodb";

export class MongoCourseReference {
  constructor(private readonly coursesCollection: Collection<Document>) {}

  async findAll(): Promise<Array<Record<string, unknown>>> {
    const docs = await this.coursesCollection.find({}).toArray();
    return docs as unknown as Array<Record<string, unknown>>;
  }
}
