import type { Router } from "express";
import type { Collection, Document } from "mongodb";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { createUserRouter } from "./user.route";
import type { AuthMiddleware } from "../auth/auth.middleware";

export interface UserModuleDependencies {
  usersCollection: Collection<Document>;
  authMiddleware: AuthMiddleware;
}

export interface UserModule {
  router: Router;
  service: UserService;
}

export function createUserModule(dependencies: UserModuleDependencies): UserModule {
  const repository = new UserRepository(dependencies.usersCollection);
  const service = new UserService(repository);
  const controller = new UserController(service);
  const router = createUserRouter(controller, dependencies.authMiddleware);
  return { router, service };
}
