import { Router } from "express";
import type { AuthMiddleware } from "../auth/auth.middleware";
import type { BookingController } from "./booking.controller";

// Auth levels and paths mirror routes/booking.routes.js and the teacher
// assignment route in routes/feedback.routes.js. POST /send-reminder is not
// migrated here (Stage 19 notifications) and stays on the legacy router.
export function createBookingRouter(controller: BookingController, authMiddleware: AuthMiddleware): Router {
  const router = Router();

  router.post("/user/book-slot", authMiddleware.verifyToken, controller.bookSlot);
  router.post("/user/attendance/bulk", authMiddleware.verifyStaff, controller.attendanceBulk);
  router.get("/user/bookings/:userId", authMiddleware.verifyToken, controller.listForUser);
  router.put("/user/bookings/:scheduleId", authMiddleware.verifyAdmin, controller.updateAttendance);

  router.get("/admin/bookings/home-with-users", authMiddleware.verifyStaff, controller.listHomeWithUsers);
  router.get("/admin/bookings/by-schedule/:scheduleId", authMiddleware.verifyStaff, controller.listBySchedule);
  router.get("/admin/bookings", authMiddleware.verifyAdmin, controller.listAdmin);
  router.put("/admin/bookings/:bookingId/teacher", authMiddleware.verifyAdmin, controller.assignTeacher);

  router.delete("/bookings/:bookingId", authMiddleware.verifyToken, controller.cancel);

  return router;
}
