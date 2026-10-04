import type { Router } from "express";
import type { Collection, Document } from "mongodb";
import { CourseRepository } from "./course.repository";
import { CourseService } from "./course.service";
import { CourseController } from "./course.controller";
import { createCourseRouter } from "./course.route";

export interface CourseModuleDependencies {
  coursesCollection: Collection<Document>;
}

export interface CourseModule {
  router: Router;
  service: CourseService;
}

export function createCourseModule(dependencies: CourseModuleDependencies): CourseModule {
  const repository = new CourseRepository(dependencies.coursesCollection);
  const service = new CourseService(repository);
  const controller = new CourseController(service);
  const router = createCourseRouter(controller);
  return { router, service };
}
