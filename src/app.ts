// Independent Express composition root. Reproduces app.js's behavior from real
// Express/Helmet/CORS/cookie-parser/mongo-sanitize imports instead of delegating
// to the whole legacy app — app.js itself is never imported by this file, only
// the narrow compat boundaries below are. Verified line-for-line against the
// real app.js (middleware order, CORS origin logic, route mounting order, 404
// and error-handler contracts) during Stage 4 build.
import express, { type Application, type Request, type Response } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import type { AppDependencies } from "./app/database/database.types";
import { initLegacyAuth } from "./app/compat/legacy-middleware";
import { mountLegacyRoutesBeforeAuth, mountLegacyRoutesAfterAuth } from "./app/compat/legacy-routes";
import { legacyEmailSender } from "./app/compat/legacy-email";
import { createAuthModule } from "./app/modules/auth/auth.module";
import type { AuthConfig } from "./app/modules/auth/auth.types";
import { createCorsMiddleware } from "./app/middleware/cors";
import { authRateLimiter, globalRateLimiter, AUTH_RATE_LIMIT_PATHS } from "./app/middleware/rate-limit";
import { notFoundHandler } from "./app/middleware/not-found";
import { errorHandler } from "./app/middleware/error-handler";
import { requestIdMiddleware } from "./app/middleware/request-id";
import { requestObservability } from "./app/middleware/request-observability";

export interface AppOptions {
  /** Raw CORS_ORIGINS value, already resolved by the caller from getConfig() —
   *  this module never reads process.env itself (single configuration owner:
   *  env.ts -> server.ts -> app.ts). */
  corsOrigins?: string;
  /** Stage 7: Auth-specific config (JWT secrets/expiries/reset link/
   *  production-cookie flag), threaded the same way corsOrigins already is —
   *  this module never reads process.env itself. Required (unlike
   *  corsOrigins, which has a legitimate production default): there is no
   *  safe default JWT secret, so every caller -- src/server.ts in production,
   *  every test that exercises the native Auth routes -- must supply its own
   *  explicit (real or fake) config. */
  authConfig: AuthConfig;
}

export function createApp(dependencies: AppDependencies, options: AppOptions): Application {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Let the remaining legacy routes' verifyToken check live account state
  // (blocked/deleted, password change) -- native Auth routes use their own
  // middleware (auth.module.ts), independent of this legacy singleton.
  initLegacyAuth(usersCollection);

  const app = express();

  // Behind Vercel's proxy: makes req.ip / secure-cookie detection correct, which
  // the rate limiter and login cookie rely on.
  app.set("trust proxy", 1);

  // Must run before everything else so x-request-id is on every response
  // (including CORS rejections and rate-limit 429s), and so the timing
  // middleware's duration covers the full pipeline.
  app.use(requestIdMiddleware);
  app.use(requestObservability);

  app.use(helmet());
  app.use(cookieParser());
  app.use(createCorsMiddleware(options.corsOrigins));
  app.use(express.json({ limit: "10mb" }));

  // Strip $-/dot-prefixed keys from body/query/params to block NoSQL operator
  // injection request-wide (defense-in-depth on top of per-route validation).
  app.use(mongoSanitize());

  // Best-effort global limiter; auth routes get a stricter one below.
  app.use(globalRateLimiter);

  app.get("/", (_req: Request, res: Response) => {
    res.json({ message: "Server is running smoothly", timestamp: new Date() });
  });

  // Stricter limits on the abuse-prone auth surface (brute-force, spam resets).
  app.use([...AUTH_RATE_LIMIT_PATHS], authRateLimiter);

  const legacyDeps = { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client };

  // Mount order preserved exactly from the legacy mountLegacyRoutes():
  // booking -> auth -> user -> feedback -> stats -> schedule. Auth is now
  // native TypeScript (src/app/modules/auth) instead of
  // routes/auth.routes.js inside this TS candidate only -- production
  // (index.js -> app.js) is unaffected and keeps using the legacy file.
  mountLegacyRoutesBeforeAuth(app, legacyDeps);
  const authModule = createAuthModule({
    usersCollection,
    config: options.authConfig,
    emailSender: legacyEmailSender,
  });
  app.use("/api/v1", authModule.router);
  mountLegacyRoutesAfterAuth(app, legacyDeps);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
