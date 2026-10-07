import type { Collection, Document } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import type { CourseRecord } from "./course.types";

export class CourseRepository {
  constructor(private readonly coursesCollection: Collection<Document>) {}

  async findAll(): Promise<CourseRecord[]> {
    return measureDatabaseOperation({ collection: "courses", operation: "course.list" }, async () => {
      const docs = await this.coursesCollection.find({}).toArray();
      return docs as unknown as CourseRecord[];
    });
  }
}
