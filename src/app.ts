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
import { mountLegacyRoutes } from "./app/compat/legacy-routes";
import { createCorsMiddleware } from "./app/middleware/cors";
import { authRateLimiter, globalRateLimiter, AUTH_RATE_LIMIT_PATHS } from "./app/middleware/rate-limit";
import { notFoundHandler } from "./app/middleware/not-found";
import { errorHandler } from "./app/middleware/error-handler";

export interface AppOptions {
  /** Raw CORS_ORIGINS value, already resolved by the caller from getConfig() —
   *  this module never reads process.env itself (single configuration owner:
   *  env.ts -> server.ts -> app.ts). */
  corsOrigins?: string;
}

export function createApp(dependencies: AppDependencies, options: AppOptions = {}): Application {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client } = dependencies;

  // Let verifyToken check live account state (blocked/deleted, password change).
  initLegacyAuth(usersCollection);

  const app = express();

  // Behind Vercel's proxy: makes req.ip / secure-cookie detection correct, which
  // the rate limiter and login cookie rely on.
  app.set("trust proxy", 1);

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

  mountLegacyRoutes(app, { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
