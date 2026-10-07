import { Router, type Request, type RequestHandler } from "express";
import type { ScheduleController } from "./schedule.controller";
import type { AuthMiddleware } from "../auth/auth.middleware";
import type { AuthActor } from "../auth/auth.types";
import { isValidScheduleIdParam } from "./schedule.validation";
import * as authz from "./schedule.authorization";

function requireAuthorized(
  predicate: (actor: AuthActor, targetUserId: string) => boolean,
  getTargetUserId: (req: Request) => string | undefined
): RequestHandler {
  return (req, res, next) => {
    const target = getTargetUserId(req);
    if (!target || !predicate(req.user ?? {}, target)) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    next();
  };
}

function validateScheduleIdParam(invalidBody: Record<string, unknown>): RequestHandler {
  return (req, res, next) => {
    if (!isValidScheduleIdParam(req.params.id)) {
      res.status(400).json(invalidBody);
      return;
    }
    next();
  };
}

export function createScheduleRouter(controller: ScheduleController, authMiddleware: AuthMiddleware): Router {
  const router = Router();

  router.post("/admin/create-schedule", authMiddleware.verifyAdmin, controller.createSchedule);

  // Keep the specific course route before the generic schedule route.
  router.get("/schedule/course/:courseId", authMiddleware.verifyToken, controller.getByCourseAndMonth);

  router.get("/schedule/:date/:courseId", authMiddleware.verifyToken, controller.getByDateAndCourse);

  router.get("/admin/get-schedules", authMiddleware.verifyStaff, controller.listAdmin);

  router.delete(
    "/admin/delete-schedule/:id",
    authMiddleware.verifyAdmin,
    validateScheduleIdParam({ message: "Invalid schedule ID format." }),
    controller.deleteSchedule
  );

  router.get(
    "/schedule/:userId",
    authMiddleware.verifyToken,
    requireAuthorized(authz.canAccessUserSchedules, (req) => req.params.userId),
    controller.getByUserId
  );

  return router;
}
