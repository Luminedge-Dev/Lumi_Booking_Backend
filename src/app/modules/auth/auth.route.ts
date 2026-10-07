import { Router } from "express";
import type { AuthController } from "./auth.controller";
import type { AuthMiddleware } from "./auth.middleware";

export function createAuthRouter(controller: AuthController, middleware: AuthMiddleware): Router {
  const router = Router();

  router.post("/register", controller.register);
  router.post("/login", controller.login);
  router.post("/auth/forget-password", controller.forgotPassword);
  router.put("/auth/reset-password", controller.resetPassword);
  router.put("/user/change-password", middleware.verifyToken, controller.changePassword);

  return router;
}
