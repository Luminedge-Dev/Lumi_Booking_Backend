import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { runPersistence } from "../../database/persistence-error";
import type { CourseRecord } from "./course.types";

// Persistence port. Stage 15: implemented on PostgreSQL/Prisma (stage13-dev).
export interface CourseRepository {
  findAll(): Promise<CourseRecord[]>;
}

export class PrismaCourseRepository implements CourseRepository {
  // The client is resolved per call, so constructing a repository (and
  // importing this module) never connects or reads NEON_DB_URL.
  constructor(private readonly getClient: () => PrismaClient = getPrismaClient) {}

  // Legacy order was Mongo natural order (insertion ~ _id order); id ASC is
  // the deterministic equivalent for Mongo-origin hex ids.
  async findAll(): Promise<CourseRecord[]> {
    return runPersistence({ table: "courses", operation: "course.list" }, async () => {
      const rows = await this.getClient().course.findMany({ orderBy: { id: "asc" } });
      return rows.map((row) => {
        const record: CourseRecord = {
          _id: row.id,
          name: row.name,
          image: row.image,
          homeBasedSystems: row.homeBasedSystems,
        };
        if (row.createdAt) record.createdAt = row.createdAt;
        if (row.updatedAt) record.updatedAt = row.updatedAt;
        return record;
      });
    });
  }
}
