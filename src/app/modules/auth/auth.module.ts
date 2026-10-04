import type { Router } from "express";
import type { Collection, Document } from "mongodb";
import { AuthRepository } from "./auth.repository";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { createAuthMiddleware, type AuthMiddleware } from "./auth.middleware";
import { createAuthRouter } from "./auth.route";
import type { AuthConfig, AuthEmailSender } from "./auth.types";

export interface AuthModuleDependencies {
  usersCollection: Collection<Document>;
  config: AuthConfig;
  emailSender: AuthEmailSender;
}

export interface AuthModule {
  router: Router;
  middleware: AuthMiddleware;
  service: AuthService;
}

// Composition root for the Auth module -- the first module built under
// AGENTS.md ss4a's module-first rules. Wires
// repository -> service -> controller/middleware -> router. Exposes
// `middleware` separately from `router` so future migrated modules can
// depend on the same verifyToken/verifyAdmin/verifyStaff without importing
// anything from inside this module's route wiring.
export function createAuthModule(dependencies: AuthModuleDependencies): AuthModule {
  const { usersCollection, config, emailSender } = dependencies;

  const repository = new AuthRepository(usersCollection);
  const service = new AuthService(repository, config);
  const controller = new AuthController(service, emailSender, config.isProduction);
  const middleware = createAuthMiddleware(service, config.jwtSecret);
  const router = createAuthRouter(controller, middleware);

  return { router, middleware, service };
}
