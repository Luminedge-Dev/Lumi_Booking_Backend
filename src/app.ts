// Independent Express composition root. Reproduces app.js's behavior from real
// Express/Helmet/CORS/cookie-parser/mongo-sanitize imports instead of delegating
// to the whole legacy app — app.js itself is never imported by this file, only
// the narrow compat boundaries below are. Verified line-for-line against the
// real app.js (middleware order, CORS origin logic, route mounting order, 404
// and error-handler contracts) during Stage 4 build.
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import mongoSanitize from "express-mongo-sanitize";
import { StatusCodes } from "http-status-codes";
import type { AppDependencies } from "./app/database/database.types";
import { initLegacyAuth, legacyAuthLimiter, legacyGlobalLimiter } from "./app/compat/legacy-middleware";
import { mountLegacyRoutes } from "./app/compat/legacy-routes";

const DEFAULT_ORIGINS = ["https://luminedge.io", "https://crm.luminedge.io", "http://localhost:3000"];

export interface AppOptions {
  /** Raw CORS_ORIGINS value, already resolved by the caller from getConfig() —
   *  this module never reads process.env itself (single configuration owner:
   *  env.ts -> server.ts -> app.ts). */
  corsOrigins?: string;
}

function resolveAllowedOrigins(rawCorsOrigins?: string): string[] {
  return rawCorsOrigins
    ? rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
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

  const allowedOrigins = resolveAllowedOrigins(options.corsOrigins);
  app.use(
    cors({
      origin(origin, cb) {
        // Allow non-browser clients (no Origin header) and any allowlisted origin.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: true,
    })
  );
  app.use(express.json({ limit: "10mb" }));

  // Strip $-/dot-prefixed keys from body/query/params to block NoSQL operator
  // injection request-wide (defense-in-depth on top of per-route validation).
  app.use(mongoSanitize());

  // Best-effort global limiter; auth routes get a stricter one below.
  app.use(legacyGlobalLimiter);

  app.get("/", (_req: Request, res: Response) => {
    res.json({ message: "Server is running smoothly", timestamp: new Date() });
  });

  // Stricter limits on the abuse-prone auth surface (brute-force, spam resets).
  app.use(
    ["/api/v1/login", "/api/v1/register", "/api/v1/auth/forget-password", "/api/v1/auth/reset-password"],
    legacyAuthLimiter
  );

  mountLegacyRoutes(app, { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, client });

  // Unmatched routes -> JSON 404 (instead of Express' default HTML page).
  app.use((_req: Request, res: Response) => {
    res.status(StatusCodes.NOT_FOUND).json({ message: "Not found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.message === "Not allowed by CORS") {
      return res.status(StatusCodes.FORBIDDEN).json({ message: "Origin not allowed" });
    }
    console.error(err.stack);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: "An unexpected error occurred. Please try again later." });
  });

  return app;
}
