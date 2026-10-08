import type { Router } from "express";
import type { CourseRepository } from "./course.repository";
import { CourseService } from "./course.service";
import { CourseController } from "./course.controller";
import { createCourseRouter } from "./course.route";

export interface CourseModuleDependencies {
  repository: CourseRepository;
}

export interface CourseModule {
  router: Router;
  service: CourseService;
}

export function createCourseModule(dependencies: CourseModuleDependencies): CourseModule {
  const service = new CourseService(dependencies.repository);
  const controller = new CourseController(service);
  const router = createCourseRouter(controller);
  return { router, service };
}
