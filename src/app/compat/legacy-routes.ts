import type { Router } from "express";
import userRoutes from "../../../routes/user.routes";
import bookingRoutes from "../../../routes/booking.routes";
import feedbackRoutes from "../../../routes/feedback.routes";
import statsRoutes from "../../../routes/stats.routes";
import scheduleRoutes from "../../../routes/schedule.routes";
import type { AppDependencies } from "../database/database.types";

export function mountLegacyRoutesBeforeAuth(router: Router, dependencies: AppDependencies): void {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Booking routes first so /user/bookings/:userId matches before /user/:userId.
  router.use(bookingRoutes({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, client }));
}

// Mounted after native User: its migrated paths shadow the matching legacy
// handlers; the rest (admin/users, user/all, PUT mutations) stay live here.
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
