import { Router, type Request, type RequestHandler } from "express";
import { ObjectId } from "mongodb";
import type { UserController } from "./user.controller";
import type { AuthMiddleware } from "../auth/auth.middleware";
import type { AuthActor } from "./user.types";
import { isValidUserIdParam, parseRequestProfileEditBody } from "./user.validation";
import * as authz from "./user.authorization";

// Thin Express adapter around a pure user.authorization.ts predicate --
// writes the exact 403 {message:"Forbidden"} directly (never delegates to
// the controller: authorization runs BEFORE the controller in the chain, so
// the controller's own try/catch can never see a rejection here).
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

// Mandatory route-collision guard (Stage 8 plan ss5): must run FIRST, before
// verifyToken/validation/authorization. Every legacy route this could
// collide with ("/admin/users", "/user/all") already requires at least
// verifyToken-level auth itself, so running native verifyToken first would
// happen to converge on the same result for an unauthenticated request --
// but putting this check first avoids relying on that coincidence, and
// critically, validation/authorization reached before this check could
// incorrectly terminate "/user/all" with their own 400/403 instead of ever
// falling through.
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

  // Admin-only list, no target user at all -- verifyAdmin ALONE (it already
  // calls verifyToken internally; chaining both would authenticate and
  // reload account state twice). No user.authorization.ts predicate applies
  // here, by design (Stage 8 plan ss2/ss6).
  router.get("/users/with-profile-request", authMiddleware.verifyAdmin, controller.listProfileEditRequests);

  // Must be last -- mirrors routes/user.routes.js's own explicit ordering
  // comment ("Must be last — catches /user/:userId after all specific
  // /user/* routes").
  router.get(
    "/user/:userId",
    passThroughNonObjectId,
    authMiddleware.verifyToken,
    requireAuthorized(authz.canAccessUserSummary, (req) => req.params.userId),
    controller.getUserSummary
  );

  return router;
}
