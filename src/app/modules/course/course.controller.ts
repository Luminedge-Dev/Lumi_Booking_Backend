import type { Request, Response } from "express";
import { logger } from "../../shared/logger/logger";
import type { CourseService } from "./course.service";

export class CourseController {
  constructor(private readonly courseService: CourseService) {}

  listCourses = async (_req: Request, res: Response): Promise<void> => {
    try {
      const courses = await this.courseService.listCourses();
      res.json({ courses });
    } catch (err) {
      logger.error("course_list_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Failed to load courses." });
    }
  };
}
