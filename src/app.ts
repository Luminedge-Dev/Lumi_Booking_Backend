import express, { type Application, type Request, type Response } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import type { AppDependencies } from "./app/database/database.types";
import type { AuthConfig } from "./app/modules/auth/auth.types";
import { createCorsMiddleware } from "./app/middleware/cors";
import { authRateLimiter, globalRateLimiter, AUTH_RATE_LIMIT_PATHS } from "./app/middleware/rate-limit";
import { notFoundHandler } from "./app/middleware/not-found";
import { errorHandler } from "./app/middleware/error-handler";
import { requestIdMiddleware } from "./app/middleware/request-id";
import { requestObservability } from "./app/middleware/request-observability";
import { createApiRouter } from "./app/router";

export interface AppOptions {
  corsOrigins: readonly string[];
  trustProxyHops: number;
  authConfig: AuthConfig;
}

export function createApp(dependencies: AppDependencies, options: AppOptions): Application {
  const app = express();

  app.set("trust proxy", options.trustProxyHops);

  app.use(requestIdMiddleware);
  app.use(requestObservability);
  app.use(helmet());
  app.use(cookieParser());
  app.use(createCorsMiddleware(options.corsOrigins));
  app.use(express.json({ limit: "10mb" }));
  app.use(mongoSanitize());
  app.use(globalRateLimiter);

  app.use([...AUTH_RATE_LIMIT_PATHS], authRateLimiter);
  app.use("/api/v1", createApiRouter(dependencies, options));

  app.get("/", (_req: Request, res: Response) => {
    res.json({ message: "Server is running smoothly", timestamp: new Date() });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
