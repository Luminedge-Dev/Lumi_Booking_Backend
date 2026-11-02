"use strict";

/**
 * Blocks the explicitly designated booking writes during an authorized ERP
 * cutover. Read the environment for every request so runtime changes are not
 * hidden by module or application startup caching.
 */
function bookingFrozen(_req, res, next) {
  if (String(process.env.BOOKING_FROZEN || "") === "1") {
    return res.status(423).json({
      message: "Booking has moved to the Luminedge portal",
      code: "BOOKING_FROZEN",
    });
  }

  return next();
}

const FROZEN_WRITE_PATHS = Object.freeze([
  { method: "POST", path: /^\/api\/v1\/user\/book-slot\/?$/i },
  { method: "DELETE", path: /^\/api\/v1\/bookings\/[^/]+\/?$/i },
  { method: "POST", path: /^\/api\/v1\/admin\/create-schedule\/?$/i },
]);

function isFrozenWriteRequest(req) {
  const method = String(req.method || "").toUpperCase();
  const path = typeof req.path === "string" ? req.path : "";
  return FROZEN_WRITE_PATHS.some((route) => route.method === method && route.path.test(path));
}

/** Early app-level check, before body parsing and the global rate limiter. */
function bookingFreezeInterceptor(req, res, next) {
  if (!isFrozenWriteRequest(req)) return next();
  return bookingFrozen(req, res, next);
}

module.exports = { bookingFrozen, bookingFreezeInterceptor, isFrozenWriteRequest };
