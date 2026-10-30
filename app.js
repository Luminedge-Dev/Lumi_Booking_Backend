const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");

const { initAuth } = require("./middleware/auth");
const { authLimiter, globalLimiter } = require("./middleware/rateLimit");
const { bookingFreezeInterceptor } = require("./middleware/frozen");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const bookingRoutes = require("./routes/booking.routes");
const feedbackRoutes = require("./routes/feedback.routes");
const statsRoutes = require("./routes/stats.routes");
const scheduleRoutes = require("./routes/schedule.routes");

// Browser origins: an exact-match allow-list (never substring matching).
// - Production: CORS_ORIGINS is required (enforced in index.js validateEnv) and
//   is the only source. localhost is never added automatically.
// - Development (NODE_ENV !== "production") with CORS_ORIGINS unset: the local
//   frontend (FRONTEND_URL_LOCAL, default http://localhost:3000) plus the
//   deployed frontend (FRONTEND_URL), each reduced to a bare origin. Missing or
//   invalid optional values are ignored, so the allow-list is always an array.
const DEFAULT_DEV_ORIGIN = "http://localhost:3000";

function toOrigin(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // fall through to the warning below
  }
  console.warn(`⚠️  ${name} is not a valid http(s) URL — ignored for CORS.`);
  return null;
}

function resolveDevOrigins() {
  const local = toOrigin("FRONTEND_URL_LOCAL") || DEFAULT_DEV_ORIGIN;
  const deployed = toOrigin("FRONTEND_URL");
  return [...new Set([local, deployed].filter(Boolean))];
}

function resolveAllowedOrigins() {
  const configured = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  if (process.env.NODE_ENV === "production") return [];
  return resolveDevOrigins();
}
const ALLOWED_ORIGINS = resolveAllowedOrigins();

module.exports = function createApp(collections) {
  const { usersCollection, coursesCollection, schedulesCollection, bookingMockCollection, reminderDeliveriesCollection, client } = collections;

  // Let verifyToken check live account state (blocked/deleted, password change).
  initAuth(usersCollection);

  const app = express();

  // Behind Vercel's proxy: makes req.ip / secure-cookie detection correct, which
  // the rate limiter and login cookie rely on.
  app.set("trust proxy", 1);

  // Security headers.
  app.use(helmet());

  app.use(cookieParser());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow non-browser clients (no Origin header) and any allowlisted origin.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: true,
    })
  );

  // FIX-07: freeze only the three designated writes before body parsing and
  // the global limiter. The route-level guards remain as defense in depth.
  app.use(bookingFreezeInterceptor);

  app.use(express.json({ limit: "10mb" }));

  // Strip $-/dot-prefixed keys from body/query/params to block NoSQL operator
  // injection request-wide (defense-in-depth on top of per-route validation).
  app.use(mongoSanitize());

  // Best-effort global limiter; auth routes get a stricter one below.
  app.use(globalLimiter);

  app.get("/", (_req, res) => {
    res.json({ message: "Server is running smoothly", timestamp: new Date() });
  });

  // Stricter limits on the abuse-prone auth surface (brute-force, spam resets).
  app.use(
    [
      "/api/v1/login",
      "/api/v1/register",
      "/api/v1/auth/forget-password",
      "/api/v1/auth/reset-password"
    ],
    authLimiter
  );

  // booking routes first so /user/bookings/:userId is matched before /user/:userId
  app.use("/api/v1", bookingRoutes({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, reminderDeliveriesCollection, client }));
  app.use("/api/v1", authRoutes({ usersCollection }));
  app.use("/api/v1", userRoutes({ usersCollection }));
  app.use("/api/v1", feedbackRoutes({ usersCollection, bookingMockCollection, client }));
  app.use("/api/v1", statsRoutes({ usersCollection, bookingMockCollection }));
  app.use("/api/v1", scheduleRoutes({ schedulesCollection, coursesCollection }));

  // Unmatched routes -> JSON 404 (instead of Express' default HTML page).
  app.use((_req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    if (err?.message === "Not allowed by CORS") {
      return res.status(403).json({ message: "Origin not allowed" });
    }
    console.error(err.stack);
    res.status(500).json({ message: "An unexpected error occurred. Please try again later." });
  });

  return app;
};
