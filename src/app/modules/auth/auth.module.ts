import type { Router } from "express";
import type { AuthRepository } from "./auth.repository";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { createAuthMiddleware, type AuthMiddleware } from "./auth.middleware";
import { createAuthRouter } from "./auth.route";
import type { AuthConfig, AuthEmailSender } from "./auth.types";

export interface AuthModuleDependencies {
  repository: AuthRepository;
  config: AuthConfig;
  emailSender: AuthEmailSender;
}

export interface AuthModule {
  router: Router;
  middleware: AuthMiddleware;
  service: AuthService;
}

export function createAuthModule(dependencies: AuthModuleDependencies): AuthModule {
  const { repository, config, emailSender } = dependencies;

  const service = new AuthService(repository, config);
  const controller = new AuthController(service, emailSender, config.isProduction);
  const middleware = createAuthMiddleware(service, config.jwtSecret);
  const router = createAuthRouter(controller, middleware);

  return { router, middleware, service };
}
