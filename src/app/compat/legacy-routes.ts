// Centralized compat boundary for legacy route factories. Static default import
// works here (verified during Stage 4 build): each routes/*.routes.js file is
// `module.exports = (deps) => { ... }` — a single function assigned to
// module.exports, which is the most reliable CJS/ESM interop case (the whole
// export becomes the default import). No require()/createRequire() exception is
// needed for this file.
//
// Stage 7 (Auth migration): routes/auth.routes.js is no longer mounted here.
// Native Auth (src/app/modules/auth) now serves those five endpoints inside
// the TS candidate. routes/auth.routes.js itself is untouched and remains
// the active production implementation via index.js -> app.js, which never
// imports anything from src/.
//
// Stage 8 (User + Course migration): native User (src/app/modules/user) is
// mounted between mountLegacyUserAndMidRoutes's predecessor call and this
// function, and native Course (src/app/modules/course) between this
// function and mountLegacyScheduleRoutes -- both via src/app.ts, not here.
// routes/user.routes.js and routes/schedule.routes.js are NEVER edited;
// native User/Course shadow 6 specific paths by mount order alone (same
// pattern Stage 7 established for Auth). The old mountLegacyRoutesAfterAuth
// is split in two so src/app.ts can insert native Course right before
// scheduleRoutes() (GET /courses lives inside schedule.routes.js), while
// userRoutes()/feedbackRoutes()/statsRoutes() stay mounted together exactly
// as before (none of those three needed a split point).
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

// Mounted after native User in src/app.ts. Still mounts the FULL, unedited
// userRoutes() -- native User's 5 migrated paths shadow the corresponding
// legacy handlers (dead code, same harmless pattern as Stage 7's
// auth.routes.js); everything else in user.routes.js (/admin/users,
// /user/all, the PUT mutation routes) still reaches this router unmodified.
export function mountLegacyUserAndMidRoutes(app: Application, dependencies: AppDependencies): void {
  const { usersCollection, bookingMockCollection, client } = dependencies;

  app.use("/api/v1", userRoutes({ usersCollection }));
  app.use("/api/v1", feedbackRoutes({ usersCollection, bookingMockCollection, client }));
  app.use("/api/v1", statsRoutes({ usersCollection, bookingMockCollection }));
}

// Mounted after native Course AND native Schedule in src/app.ts (Stage 9).
// GET /courses, POST /admin/create-schedule, GET /schedule/:date/:courseId,
// GET /admin/get-schedules, and DELETE /admin/delete-schedule/:id inside
// scheduleRoutes() all become shadowed/dead code; GET /schedule/:userId
// (deliberately NOT migrated -- no frontend caller, never populated by this
// file's own writes) remains the one route this mount call still actually
// serves. No further split needed: native Schedule shadows multiple paths
// within this same already-isolated legacy file, so mounting it immediately
// before this one call is sufficient.
export function mountLegacyScheduleRoutes(app: Application, dependencies: AppDependencies): void {
  const { coursesCollection, schedulesCollection } = dependencies;

  app.use("/api/v1", scheduleRoutes({ schedulesCollection, coursesCollection }));
}
