import { Router } from "express";
import type { AuthController } from "./auth.controller";
import type { AuthMiddleware } from "./auth.middleware";

// Paths/methods/native middleware binding only -- no business logic or Mongo
// access here (AGENTS.md layer rules). Exact same five paths as
// routes/auth.routes.js; this router replaces that file only inside the TS
// candidate (src/app.ts) -- production (index.js -> app.js) keeps using the
// original file directly and never imports this.
export function createAuthRouter(controller: AuthController, middleware: AuthMiddleware): Router {
  const router = Router();

  router.post("/register", controller.register);
  router.post("/login", controller.login);
  router.post("/auth/forget-password", controller.forgotPassword);
  router.put("/auth/reset-password", controller.resetPassword);
  router.put("/user/change-password", middleware.verifyToken, controller.changePassword);

  return router;
}
