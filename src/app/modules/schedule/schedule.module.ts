import type { Router } from "express";
import type { ScheduleRepository } from "./schedule.repository";
import { ScheduleService } from "./schedule.service";
import { ScheduleController } from "./schedule.controller";
import { createScheduleRouter } from "./schedule.route";
import type { AuthMiddleware } from "../auth/auth.middleware";

export interface ScheduleModuleDependencies {
  repository: ScheduleRepository;
  authMiddleware: AuthMiddleware;
}

export interface ScheduleModule {
  router: Router;
  service: ScheduleService;
}

export function createScheduleModule(dependencies: ScheduleModuleDependencies): ScheduleModule {
  const service = new ScheduleService(dependencies.repository);
  const controller = new ScheduleController(service);
  const router = createScheduleRouter(controller, dependencies.authMiddleware);
  return { router, service };
}
