// Centralized compat boundary for legacy middleware. Static import works here
// (verified during Stage 4 build): middleware/auth.js and middleware/rateLimit.js
// both assign a plain object to module.exports (`{ initAuth, verifyToken, ... }`,
// `{ authLimiter, globalLimiter }`), which Node's CJS/ESM interop and tsx both
// resolve correctly as named bindings. No require()/createRequire() exception is
// needed for this file.
import type { RequestHandler } from "express";
import { initAuth } from "../../../middleware/auth";
import { authLimiter, globalLimiter } from "../../../middleware/rateLimit";
import type { AppCollections } from "../database/database.types";

export function initLegacyAuth(usersCollection: AppCollections["usersCollection"]): void {
  initAuth(usersCollection);
}

export const legacyAuthLimiter = authLimiter as RequestHandler;
export const legacyGlobalLimiter = globalLimiter as RequestHandler;
