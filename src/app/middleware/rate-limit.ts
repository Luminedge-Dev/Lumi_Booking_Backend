// Thresholds/messages mirror middleware/rateLimit.js exactly; changes are security decisions.
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

export function createAuthRateLimiter(): RequestHandler {
  return rateLimit(AUTH_LIMITER_POLICY);
}

export function createGlobalRateLimiter(): RequestHandler {
  return rateLimit(GLOBAL_LIMITER_POLICY);
}

export const authRateLimiter: RequestHandler = createAuthRateLimiter();
export const globalRateLimiter: RequestHandler = createGlobalRateLimiter();

export const AUTH_RATE_LIMIT_PATHS = [
  "/api/v1/login",
  "/api/v1/register",
  "/api/v1/auth/forget-password",
  "/api/v1/auth/reset-password",
] as const;
