import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import type { AuthService } from "./auth.service";
import type { AuthActor } from "./auth.types";

// Required module file (not optional): this middleware is consumed by this
// module's own five routes now, and will be consumed by other modules once
// they migrate -- it does not belong inside auth.controller.ts, which only
// handles the five HTTP endpoints.
//
// Every response here is written directly (res.status(...).json(...)),
// never via next(AppError) / the shared errorHandler: that handler only ever
// serializes {message} from an AppError and silently drops errorCode, but
// every locked legacy 401 body here is {message, code}. Modifying the shared
// error-handler contract to special-case Auth was explicitly rejected in
// favor of keeping domain response shapes inside the owning module.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthActor;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.token;
  if (cookieToken) return cookieToken;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return null;
}

export function createAuthMiddleware(authService: AuthService, jwtSecret: string) {
  const verifyToken: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ message: "Unauthorized", code: "NO_TOKEN" });
      return;
    }

    let decoded: AuthActor;
    try {
      decoded = jwt.verify(token, jwtSecret) as AuthActor;
    } catch (err) {
      const expired = (err as { name?: string })?.name === "TokenExpiredError";
      res.status(401).json({
        message: expired ? "Token expired" : "Invalid token",
        code: expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
      });
      return;
    }

    try {
      const state = await authService.checkAccountState(decoded);
      if (!state.ok) {
        res.status(401).json({ message: "Session no longer valid", code: state.code });
        return;
      }
      // Prefer the live role so a demoted/promoted user is handled correctly.
      req.user = state.role ? { ...decoded, role: state.role } : decoded;
      next();
    } catch (err) {
      console.error("Auth account-state check failed:", (err as Error)?.message);
      res.status(500).json({ message: "Authentication error" });
    }
  };

  const verifyAdmin: RequestHandler = (req, res, next) => {
    verifyToken(req, res, () => {
      if (req.user?.role !== "admin") {
        res.status(403).json({ message: "Forbidden: admins only" });
        return;
      }
      next();
    });
  };

  const verifyStaff: RequestHandler = (req, res, next) => {
    verifyToken(req, res, () => {
      const allowed = ["admin", "bdm", "teacher"];
      if (!allowed.includes(req.user?.role ?? "")) {
        res.status(403).json({ message: "Forbidden: staff only" });
        return;
      }
      next();
    });
  };

  return { verifyToken, verifyAdmin, verifyStaff };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
