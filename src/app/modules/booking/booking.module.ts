import type { Router } from "express";
import type { AuthMiddleware } from "../auth/auth.middleware";
import { BookingController } from "./booking.controller";
import type { BookingRepository } from "./booking.repository";
import { createBookingRouter } from "./booking.route";
import { BookingService, type BookingNotifier } from "./booking.service";

export interface BookingModuleDependencies {
  repository: BookingRepository;
  notifier: BookingNotifier;
  authMiddleware: AuthMiddleware;
}

export interface BookingModule {
  router: Router;
  service: BookingService;
}

export function createBookingModule(dependencies: BookingModuleDependencies): BookingModule {
  const service = new BookingService(dependencies.repository, dependencies.notifier);
  const controller = new BookingController(service);
  return { router: createBookingRouter(controller, dependencies.authMiddleware), service };
}
