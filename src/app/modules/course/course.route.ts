import { Router } from "express";
import type { CourseController } from "./course.controller";

// GET /courses only -- public, no auth middleware (matches legacy exactly).
// Router() created fresh inside this factory, same as auth.route.ts -- avoids
// the legacy Router()-singleton accumulation bug Stage 7 found.
export function createCourseRouter(controller: CourseController): Router {
  const router = Router();
  router.get("/courses", controller.listCourses);
  return router;
}
