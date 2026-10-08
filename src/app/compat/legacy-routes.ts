import type { Router } from "express";
import userRoutes from "../../../routes/user.routes";
import bookingRoutes from "../../../routes/booking.routes";
import feedbackRoutes from "../../../routes/feedback.routes";
import statsRoutes from "../../../routes/stats.routes";
import scheduleRoutes from "../../../routes/schedule.routes";
import type { AppDependencies } from "../database/database.types";

// Stage 16: native Booking owns every booking path except POST /send-reminder
// (Stage 19 notifications). The legacy booking router stays mounted AFTER the
// native one: its migrated handlers are shadowed (kept for rollback), and
// /send-reminder remains live here with the Mongo-backed legacy auth.
// The legacy factory shares a module-level Router(), so call this exactly once.
export function mountLegacyBookingRoutes(router: Router, dependencies: AppDependencies): void {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  router.use(bookingRoutes({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, client }));
}

// Mounted after native User: its migrated paths (including Stage 16B admin PUT
// mutations) shadow the matching legacy handlers; GET /admin/users and
// GET /user/all stay live here (B8).
export function mountLegacyUserAndMidRoutes(router: Router, dependencies: AppDependencies): void {
  const { usersCollection, bookingMockCollection, client } = dependencies;

  router.use(userRoutes({ usersCollection }));
  router.use(feedbackRoutes({ usersCollection, bookingMockCollection, client }));
  router.use(statsRoutes({ usersCollection, bookingMockCollection }));
}

// Mounted after native Course and Schedule: every path in this file is
// shadowed dead code, kept mounted for rollback safety.
export function mountLegacyScheduleRoutes(router: Router, dependencies: AppDependencies): void {
  const { coursesCollection, schedulesCollection } = dependencies;

  router.use(scheduleRoutes({ schedulesCollection, coursesCollection }));
}
