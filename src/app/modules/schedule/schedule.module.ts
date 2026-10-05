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

// Composition root for the Schedule module. Reuses Stage 7's native Auth
// middleware directly (verifyToken/verifyAdmin/verifyStaff) -- no
// schedule.authorization.ts exists, since this module has no per-resource
// ownership policy (plain role guards are the entire authorization story).
export function createScheduleModule(dependencies: ScheduleModuleDependencies): ScheduleModule {
  const repository = new ScheduleRepository(dependencies.schedulesCollection);
  const service = new ScheduleService(repository);
  const controller = new ScheduleController(service);
  const router = createScheduleRouter(controller, dependencies.authMiddleware);
  return { router, service };
}
