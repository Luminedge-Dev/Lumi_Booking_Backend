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
import type { CoreRepositories } from "../runtime/core-repositories";

export interface ApiRouterOptions {
  authConfig: AuthConfig;
  // Stage 15: persistence for the migrated core modules (PostgreSQL). The
  // Mongo collections in `dependencies` still back every unmigrated module.
  repositories: CoreRepositories;
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

  // Stage 15: Auth/User/Course/Schedule persist in PostgreSQL via the
  // repositories injected by the composition root; usersCollection above is
  // used only by the still-legacy routes and their live account-state check.
  const authModule = createAuthModule({
    repository: options.repositories.auth,
    config: options.authConfig,
    emailSender: legacyEmailSender,
  });
  router.use(authModule.router);

  const userModule = createUserModule({ repository: options.repositories.user, authMiddleware: authModule.middleware });
  router.use(userModule.router);
  mountLegacyUserAndMidRoutes(router, legacyDeps);

  const courseModule = createCourseModule({ repository: options.repositories.course });
  router.use(courseModule.router);

  const scheduleModule = createScheduleModule({ repository: options.repositories.schedule, authMiddleware: authModule.middleware });
  router.use(scheduleModule.router);
  mountLegacyScheduleRoutes(router, legacyDeps);

  return router;
}
