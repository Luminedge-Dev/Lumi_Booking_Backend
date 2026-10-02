// Centralized compat boundary for legacy middleware. Static import works here
// (verified during Stage 4 build): middleware/auth.js assigns a plain object
// to module.exports (`{ initAuth, verifyToken, ... }`), which Node's CJS/ESM
// interop and tsx both resolve correctly as named bindings. No
// require()/createRequire() exception is needed for this file.
//
// Stage 5 migrated rate limiting to native TypeScript
// (src/app/middleware/rate-limit.ts) — this file no longer references
// middleware/rateLimit.js at all. Auth itself stays legacy until its own
// dedicated migration stage.
import { initAuth } from "../../../middleware/auth";
import type { AppCollections } from "../database/database.types";

export function initLegacyAuth(usersCollection: AppCollections["usersCollection"]): void {
  initAuth(usersCollection);
}
