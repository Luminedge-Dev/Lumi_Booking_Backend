import { Router } from "express";
import type { CourseController } from "./course.controller";

export function createCourseRouter(controller: CourseController): Router {
  const router = Router();
  router.get("/courses", controller.listCourses);
  return router;
}
