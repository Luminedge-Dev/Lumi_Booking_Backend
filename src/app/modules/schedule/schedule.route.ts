import { Router, type RequestHandler } from "express";
import type { ScheduleController } from "./schedule.controller";
import type { AuthMiddleware } from "../auth/auth.middleware";
import { isValidScheduleIdParam } from "./schedule.validation";

// Path/method, the correct native guard per route, thin validation
// adapters, controller call only -- no Mongo, no business logic.
//
// No verifyToken + verifyAdmin / verifyToken + verifyStaff chaining:
// verifyAdmin/verifyStaff already call verifyToken internally (confirmed
// directly from auth.middleware.ts, same reasoning Stage 8 applied to
// /users/with-profile-request).
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

  // MANDATORY ORDERING: this route MUST be registered before
  // GET /schedule/:date/:courseId, or a request to
  // /schedule/course/<id> would be captured by the generic daily route as
  // date="course", courseId="<id>". Both routes are native and both are
  // verifyToken-gated -- no fallthrough guard is needed, this is purely a
  // within-file registration-order requirement (locked by a dedicated
  // architecture test).
  router.get("/schedule/course/:courseId", authMiddleware.verifyToken, controller.getByCourseAndMonth);

  // NO new validation beyond legacy behavior -- confirmed by direct code
  // read that this route takes date/courseId as raw path-param strings
  // with no ObjectId/date-format check anywhere in the legacy handler.
  router.get("/schedule/:date/:courseId", authMiddleware.verifyToken, controller.getByDateAndCourse);

  router.get("/admin/get-schedules", authMiddleware.verifyStaff, controller.listAdmin);

  router.delete(
    "/admin/delete-schedule/:id",
    authMiddleware.verifyAdmin,
    validateScheduleIdParam({ message: "Invalid schedule ID format." }),
    controller.deleteSchedule
  );

  return router;
}
