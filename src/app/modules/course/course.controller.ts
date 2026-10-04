import type { Request, Response } from "express";
import type { CourseService } from "./course.service";

// req/res boundary only -- no Mongo, no business logic (AGENTS.md layer rules).
export class CourseController {
  constructor(private readonly courseService: CourseService) {}

  listCourses = async (_req: Request, res: Response): Promise<void> => {
    try {
      const courses = await this.courseService.listCourses();
      res.json({ courses });
    } catch (err) {
      console.error("Error fetching courses:", err);
      res.status(500).json({ message: "Failed to load courses." });
    }
  };
}
