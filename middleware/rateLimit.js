const rateLimit = require("express-rate-limit");

// NOTE: the default store is in-memory. On Vercel serverless each container
// keeps its own counters, so limiting is best-effort across instances — it
// stops casual brute-force/spam from a single warm instance but is not a hard
// global guarantee. Swap in a shared store (e.g. Redis) if strict limits are
// needed later.

const common = {
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false,
  // Behind Vercel's proxy, express-rate-limit reads the client IP from
  // req.ip, which is correct only when `trust proxy` is set (done in app.js).
};

// Strict limiter for sensitive auth endpoints (login, register, password reset):
// brute-force and email/cost-abuse surfaces.
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: "Too many attempts. Please try again later." },
});

// Looser catch-all limiter for the rest of the API.
const globalLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { message: "Too many requests. Please slow down." },
});

module.exports = { authLimiter, globalLimiter };
