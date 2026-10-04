import type { Collection, Document } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import type { CourseRecord } from "./course.types";

// The only file in this module touching coursesCollection directly.
// find({}).toArray() with no projection, matching
// routes/schedule.routes.js:60-68 exactly -- full raw documents.
export class CourseRepository {
  constructor(private readonly coursesCollection: Collection<Document>) {}

  async findAll(): Promise<CourseRecord[]> {
    return measureDatabaseOperation({ collection: "courses", operation: "course.list" }, async () => {
      const docs = await this.coursesCollection.find({}).toArray();
      return docs as unknown as CourseRecord[];
    });
  }
}
