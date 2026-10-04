import type { CourseRepository } from "./course.repository";
import { toCourseDto } from "./course.mapper";
import type { CourseDto } from "./course.types";

export class CourseService {
  constructor(private readonly repository: CourseRepository) {}

  async listCourses(): Promise<CourseDto[]> {
    const records = await this.repository.findAll();
    return records.map(toCourseDto);
  }
}
