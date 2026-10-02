// Literal TypeScript port of middleware/rateLimit.js's express-rate-limit
// config — not a policy change. Thresholds/messages must match exactly; any
// future change to limits is a deliberate security decision, not a side
// effect of this migration.
//
// Exposes immutable policy objects + factories (createAuthRateLimiter /
// createGlobalRateLimiter) in addition to the production singletons, so
// tests can build an isolated limiter/store rather than exercising (and
// polluting) the shared instance actually mounted in app.ts.
import rateLimit, { type Options } from "express-rate-limit";
import type { RequestHandler } from "express";

const COMMON_POLICY = {
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false, // no X-RateLimit-*
} as const;

export const AUTH_LIMITER_POLICY = {
  ...COMMON_POLICY,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: "Too many attempts. Please try again later." },
} as const satisfies Partial<Options>;

export const GLOBAL_LIMITER_POLICY = {
  ...COMMON_POLICY,
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { message: "Too many requests. Please slow down." },
} as const satisfies Partial<Options>;

// Each call builds a brand-new limiter with its own fresh default
// MemoryStore — used by the production singletons below (each gets exactly
// one long-lived store) and by tests that want an isolated instance instead
// of sharing counters with the singleton mounted in app.ts.
export function createAuthRateLimiter(): RequestHandler {
  return rateLimit(AUTH_LIMITER_POLICY);
}

export function createGlobalRateLimiter(): RequestHandler {
  return rateLimit(GLOBAL_LIMITER_POLICY);
}

export const authRateLimiter: RequestHandler = createAuthRateLimiter();
export const globalRateLimiter: RequestHandler = createGlobalRateLimiter();

// Security-policy-as-code: the only paths the stricter auth limiter targets.
// Kept beside the limiter (not a separate constants file) so the policy and
// its enforcement stay co-located.
export const AUTH_RATE_LIMIT_PATHS = [
  "/api/v1/login",
  "/api/v1/register",
  "/api/v1/auth/forget-password",
  "/api/v1/auth/reset-password",
] as const;
