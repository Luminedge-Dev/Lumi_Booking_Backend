import { Router, type Request, type RequestHandler } from "express";
import { ObjectId } from "mongodb";
import type { UserController } from "./user.controller";
import type { AuthMiddleware } from "../auth/auth.middleware";
import type { AuthActor } from "./user.types";
import { isValidUserIdParam, parseRequestProfileEditBody } from "./user.validation";
import * as authz from "./user.authorization";

function requireAuthorized(
  predicate: (actor: AuthActor, targetUserId: string) => boolean,
  getTargetUserId: (req: Request) => string | undefined
): RequestHandler {
  return (req, res, next) => {
    const target = getTargetUserId(req);
    if (!target || !predicate(req.user ?? {}, target)) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    next();
  };
}

function validateUserIdParam(invalidBody: Record<string, unknown>): RequestHandler {
  return (req, res, next) => {
    if (!isValidUserIdParam(req.params.userId)) {
      res.status(400).json(invalidBody);
      return;
    }
    next();
  };
}

const validateProfileEditBody: RequestHandler = (req, res, next) => {
  if (!parseRequestProfileEditBody(req.body)) {
    res.status(400).json({ success: false, message: "Invalid or missing userId" });
    return;
  }
  next();
};

// Collision guard: must run FIRST so non-ObjectId ids fall through instead of 400/403 here.
const passThroughNonObjectId: RequestHandler = (req, res, next) => {
  if (!ObjectId.isValid(req.params.userId)) {
    next("route");
    return;
  }
  next();
};

export function createUserRouter(controller: UserController, authMiddleware: AuthMiddleware): Router {
  const router = Router();

  router.get(
    "/user/status/:userId",
    authMiddleware.verifyToken,
    validateUserIdParam({ message: "Invalid user ID format." }),
    requireAuthorized(authz.canAccessUserStatus, (req) => req.params.userId),
    controller.getStatus
  );

  router.get(
    "/profile/:userId",
    authMiddleware.verifyToken,
    validateUserIdParam({ success: false, message: "Invalid user ID" }),
    requireAuthorized(authz.canAccessProfile, (req) => req.params.userId),
    controller.getProfile
  );

  router.post(
    "/user/request-profile-edit",
    authMiddleware.verifyToken,
    validateProfileEditBody,
    requireAuthorized(authz.canRequestProfileEdit, (req) => (req.body as { userId?: string })?.userId),
    controller.requestProfileEdit
  );

  // verifyAdmin already calls verifyToken internally; chaining both would authenticate twice.
  router.get("/users/with-profile-request", authMiddleware.verifyAdmin, controller.listProfileEditRequests);

  // Must be last: catches /user/:userId only after specific /user/* routes.
  router.get(
    "/user/:userId",
    passThroughNonObjectId,
    authMiddleware.verifyToken,
    requireAuthorized(authz.canAccessUserSummary, (req) => req.params.userId),
    controller.getUserSummary
  );

  return router;
}
