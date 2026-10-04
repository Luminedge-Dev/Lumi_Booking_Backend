// Centralized compat boundary for legacy route factories. Static default import
// works here (verified during Stage 4 build): each routes/*.routes.js file is
// `module.exports = (deps) => { ... }` — a single function assigned to
// module.exports, which is the most reliable CJS/ESM interop case (the whole
// export becomes the default import). No require()/createRequire() exception is
// needed for this file.
//
// Stage 7 (Auth migration): routes/auth.routes.js is no longer mounted here.
// Native Auth (src/app/modules/auth) now serves those five endpoints inside
// the TS candidate. This file is split into two mount functions so src/app.ts
// can insert native Auth between them, preserving the exact legacy mount
// order (booking -> auth -> user -> feedback -> stats -> schedule).
// routes/auth.routes.js itself is untouched and remains the active
// production implementation via index.js -> app.js, which never imports
// anything from src/.
import type { Application } from "express";
import userRoutes from "../../../routes/user.routes";
import bookingRoutes from "../../../routes/booking.routes";
import feedbackRoutes from "../../../routes/feedback.routes";
import statsRoutes from "../../../routes/stats.routes";
import scheduleRoutes from "../../../routes/schedule.routes";
import type { AppDependencies } from "../database/database.types";

export function mountLegacyRoutesBeforeAuth(app: Application, dependencies: AppDependencies): void {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Order preserved exactly from app.js: booking routes first so
  // /user/bookings/:userId matches before /user/:userId.
  app.use("/api/v1", bookingRoutes({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, client }));
}

export function mountLegacyRoutesAfterAuth(app: Application, dependencies: AppDependencies): void {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  app.use("/api/v1", userRoutes({ usersCollection }));
  app.use("/api/v1", feedbackRoutes({ usersCollection, bookingMockCollection, client }));
  app.use("/api/v1", statsRoutes({ usersCollection, bookingMockCollection }));
  app.use("/api/v1", scheduleRoutes({ schedulesCollection, coursesCollection }));
}
