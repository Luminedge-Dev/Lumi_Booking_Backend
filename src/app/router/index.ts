import { Router, type Router as ExpressRouter } from "express";
import type { AppDependencies } from "../database/database.types";
import { initLegacyAuth } from "../compat/legacy-middleware";
import {
  mountLegacyRoutesBeforeAuth,
  mountLegacyUserAndMidRoutes,
  mountLegacyScheduleRoutes,
} from "../compat/legacy-routes";
import { legacyEmailSender } from "../compat/legacy-email";
import { createAuthModule } from "../modules/auth/auth.module";
import { createUserModule } from "../modules/user/user.module";
import { createCourseModule } from "../modules/course/course.module";
import { createScheduleModule } from "../modules/schedule/schedule.module";
import type { AuthConfig } from "../modules/auth/auth.types";

export interface ApiRouterOptions {
  authConfig: AuthConfig;
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

  // Preserve legacy route precedence while native modules shadow migrated paths.
  mountLegacyRoutesBeforeAuth(router, legacyDeps);

  const authModule = createAuthModule({
    usersCollection,
    config: options.authConfig,
    emailSender: legacyEmailSender,
  });
  router.use(authModule.router);

  const userModule = createUserModule({ usersCollection, authMiddleware: authModule.middleware });
  router.use(userModule.router);
  mountLegacyUserAndMidRoutes(router, legacyDeps);

  const courseModule = createCourseModule({ coursesCollection });
  router.use(courseModule.router);

  const scheduleModule = createScheduleModule({ schedulesCollection, authMiddleware: authModule.middleware });
  router.use(scheduleModule.router);
  mountLegacyScheduleRoutes(router, legacyDeps);

  return router;
}
