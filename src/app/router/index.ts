import { Router, type Router as ExpressRouter } from "express";
import type { AppDependencies } from "../database/database.types";
import { initLegacyAuth } from "../compat/legacy-middleware";
import {
  mountLegacyBookingRoutes,
  mountLegacyUserAndMidRoutes,
  mountLegacyScheduleRoutes,
} from "../compat/legacy-routes";
import { legacyBookingNotifier, legacyEmailSender, legacyUserNotifier } from "../compat/legacy-email";
import { createAuthModule } from "../modules/auth/auth.module";
import { createUserModule } from "../modules/user/user.module";
import { createCourseModule } from "../modules/course/course.module";
import { createScheduleModule } from "../modules/schedule/schedule.module";
import { createBookingModule } from "../modules/booking/booking.module";
import type { AuthConfig } from "../modules/auth/auth.types";
import type { CoreRepositories } from "../runtime/core-repositories";
import type { BookingNotifier } from "../modules/booking/booking.service";
import type { UserNotifier } from "../modules/user/user.service";

export interface ApiRouterOptions {
  authConfig: AuthConfig;
  // Stage 15: persistence for the migrated core modules (PostgreSQL). The
  // Mongo collections in `dependencies` still back every unmigrated module.
  repositories: CoreRepositories;
  bookingNotifier?: BookingNotifier;
  userNotifier?: UserNotifier;
}

// Single API composition owner: native modules plus the legacy
// compatibility mounts, in dependency order.
export function createApiRouter(
  dependencies: AppDependencies,
  options: ApiRouterOptions,
): ExpressRouter {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Let the remaining legacy routes' verifyToken check live account state.
  initLegacyAuth(usersCollection);

  const router = Router();
  const legacyDeps = { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client };

  // Stage 15: Auth/User/Course/Schedule persist in PostgreSQL via the
  // repositories injected by the composition root; usersCollection above is
  // used only by the still-legacy routes and their live account-state check.
  const authModule = createAuthModule({
    repository: options.repositories.auth,
    config: options.authConfig,
    emailSender: legacyEmailSender,
  });
  router.use(authModule.router);

  // Stage 16: Booking (and Home teacher assignment) persist in PostgreSQL.
  // Mounted before the legacy booking router so native handlers (and the
  // PostgreSQL-backed auth middleware) take every booking path; the legacy
  // router remains mounted behind it for rollback and POST /send-reminder.
  const bookingModule = createBookingModule({
    repository: options.repositories.booking,
    notifier: options.bookingNotifier ?? legacyBookingNotifier,
    authMiddleware: authModule.middleware,
  });
  router.use(bookingModule.router);
  mountLegacyBookingRoutes(router, legacyDeps);

  const userModule = createUserModule({
    repository: options.repositories.user,
    authMiddleware: authModule.middleware,
    notifier: options.userNotifier ?? legacyUserNotifier,
  });
  router.use(userModule.router);
  mountLegacyUserAndMidRoutes(router, legacyDeps);

  const courseModule = createCourseModule({ repository: options.repositories.course });
  router.use(courseModule.router);

  const scheduleModule = createScheduleModule({ repository: options.repositories.schedule, authMiddleware: authModule.middleware });
  router.use(scheduleModule.router);
  mountLegacyScheduleRoutes(router, legacyDeps);

  return router;
}
