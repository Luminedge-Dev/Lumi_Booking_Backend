import type { Router } from "express";
import type { Collection, Document } from "mongodb";
import { ScheduleRepository } from "./schedule.repository";
import { ScheduleService } from "./schedule.service";
import { ScheduleController } from "./schedule.controller";
import { createScheduleRouter } from "./schedule.route";
import type { AuthMiddleware } from "../auth/auth.middleware";

export interface ScheduleModuleDependencies {
  schedulesCollection: Collection<Document>;
  authMiddleware: AuthMiddleware;
}

export interface ScheduleModule {
  router: Router;
  service: ScheduleService;
}

export function createScheduleModule(dependencies: ScheduleModuleDependencies): ScheduleModule {
  const repository = new ScheduleRepository(dependencies.schedulesCollection);
  const service = new ScheduleService(repository);
  const controller = new ScheduleController(service);
  const router = createScheduleRouter(controller, dependencies.authMiddleware);
  return { router, service };
}
