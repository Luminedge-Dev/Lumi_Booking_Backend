// Centralized compat boundary for legacy route factories. Static default import
// works here (verified during Stage 4 build): each routes/*.routes.js file is
// `module.exports = (deps) => { ... }` — a single function assigned to
// module.exports, which is the most reliable CJS/ESM interop case (the whole
// export becomes the default import). No require()/createRequire() exception is
// needed for this file.
import type { Application } from "express";
import authRoutes from "../../../routes/auth.routes";
import userRoutes from "../../../routes/user.routes";
import bookingRoutes from "../../../routes/booking.routes";
import feedbackRoutes from "../../../routes/feedback.routes";
import statsRoutes from "../../../routes/stats.routes";
import scheduleRoutes from "../../../routes/schedule.routes";
import type { AppDependencies } from "../database/database.types";

export function mountLegacyRoutes(app: Application, dependencies: AppDependencies): void {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Order preserved exactly from app.js: booking routes first so
  // /user/bookings/:userId matches before /user/:userId.
  app.use("/api/v1", bookingRoutes({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, client }));
  app.use("/api/v1", authRoutes({ usersCollection }));
  app.use("/api/v1", userRoutes({ usersCollection }));
  app.use("/api/v1", feedbackRoutes({ usersCollection, bookingMockCollection, client }));
  app.use("/api/v1", statsRoutes({ usersCollection, bookingMockCollection }));
  app.use("/api/v1", scheduleRoutes({ schedulesCollection, coursesCollection }));
}
