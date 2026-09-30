require("dotenv").config();
const { connectDB, getCollections, client, ensureHealthy } = require("./config/db");
const { getIndexOps } = require("./config/indexDefinitions");
const { startReminderCron } = require("./jobs/reminderCron");
const createApp = require("./app");

// Fail fast if the security-critical config is missing rather than signing
// tokens with `undefined` or 500-ing deep inside a request. Runs at module load
// so a misconfigured deploy surfaces clearly on cold start.
function validateEnv() {
  const required = ["MONGODB_URI", "JWT_SECRET", "JWT_RESET_PASS_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing required environment variable(s): ${missing.join(", ")}`);
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  // Email is non-fatal (emailSender degrades gracefully), but warn loudly so a
  // broken email config is visible in logs.
  if (!process.env.SMTP_HOST) {
    console.warn("⚠️  SMTP_HOST is not set — outbound email will fail.");
  }
  if (!process.env.EMAIL || !process.env.APP_PASS) {
    console.warn("⚠️  EMAIL and/or APP_PASS is not set — SMTP authentication will fail.");
  }
  if (!process.env.EMAIL_FROM && !process.env.EMAIL) {
    console.warn("⚠️  Neither EMAIL_FROM nor EMAIL is set — email 'from' address is undefined.");
  }

  // SMTP_PORT and SMTP_SECURE must agree (465 <-> implicit TLS, 587 <-> STARTTLS)
  // or every send fails with zero other signal — warn loudly on the two known
  // mismatches so this is visible on cold start rather than only in failed-send logs.
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = process.env.SMTP_SECURE === "true";
  if (smtpPort === 465 && !smtpSecure) {
    console.warn(
      "⚠️  SMTP_PORT=465 requires SMTP_SECURE=true (implicit TLS) — email will fail as configured."
    );
  }
  if (smtpPort === 587 && smtpSecure) {
    console.warn(
      "⚠️  SMTP_PORT=587 normally pairs with SMTP_SECURE=false (STARTTLS) — email may fail as configured."
    );
  }

  // On a serverless host the login cookie only gets `secure; sameSite=None`
  // when NODE_ENV === "production" (see routes/auth.routes.js). Without it the
  // cookie is `Lax; insecure` and browsers drop it on cross-site requests from
  // the frontend — the original 401 loop. Warn loudly if it's misconfigured.
  if (process.env.VERCEL && process.env.NODE_ENV !== "production") {
    console.warn(
      "⚠️  NODE_ENV is not 'production' on a serverless deploy — auth cookies will not be sent cross-site (expect 401 loops)."
    );
  }
}

validateEnv();

const port = process.env.PORT || 5000;
// Vercel (and most serverless platforms) set this automatically.
const isServerless = !!process.env.VERCEL;

async function ensureIndexes(collections) {
  // Sequential, not Promise.all: on a cold start these compete for the same
  // pool (maxPoolSize 10) as the request that triggered the cold start. Running
  // them one at a time keeps index creation to a single checked-out connection
  // instead of bursting up to 18 at once and starving that live request.
  //
  // Each op is caught individually so one failing index (e.g. a duplicate-key
  // conflict on the unique email index) doesn't stop the rest from being
  // attempted — matching the old Promise.all's resilience, where all 18 were
  // already in flight before any one of them could reject.
  const errors = [];
  for (const op of getIndexOps(collections)) {
    try {
      await op();
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) {
    throw new Error(`${errors.length} index operation(s) failed: ${errors.join("; ")}`);
  }
  console.log("✅ MongoDB indexes ensured.");
}

// Cache the connected app across invocations so a warm serverless
// container reuses the same Mongo connection instead of reconnecting
// (and 500-ing) on every request.
let appPromise;

async function bootstrap() {
  await connectDB();

  const collections = { ...getCollections(), client };

  // Ensure indexes once per process. Fire-and-forget so a slow index build
  // never blocks request handling or crashes startup; createIndex is
  // idempotent, so this is a cheap no-op when the indexes already exist.
  // This runs on serverless too, so a clean Vercel-only database still gets
  // the unique {email} index and the rest. Set SKIP_INDEX_ENSURE_ON_BOOT=true
  // once scripts/ensure-indexes.js has been run against an environment and
  // its indexes are stable, to drop this from every cold start entirely.
  if (process.env.SKIP_INDEX_ENSURE_ON_BOOT !== "true") {
    ensureIndexes(collections).catch((err) =>
      console.error("Index creation failed:", err.message)
    );
  }

  // Background cron only works on a long-lived server; serverless containers
  // are torn down between requests, so the interval never fires reliably.
  if (!isServerless) {
    startReminderCron(collections.usersCollection);
  }

  return createApp(collections);
}

function getApp() {
  if (!appPromise) appPromise = bootstrap();
  return appPromise;
}

// Always export a request handler so Vercel's @vercel/node builder can
// find it (this is what fixes the "No exports found in module" 500s).
module.exports = async (req, res) => {
  try {
    const app = await getApp();
    await ensureHealthy(); // cheap when healthy; repairs a wedged shared client before this request touches it
    return app(req, res);
  } catch (err) {
    console.error("Failed to initialize app:", err);
    appPromise = undefined; // allow a retry on the next request
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Server initialization failed." }));
  }
};

// When running as a normal long-lived process (local dev, non-serverless
// hosts) also bind a port. Skipped on Vercel, which invokes the export above.
if (!isServerless) {
  getApp()
    .then((app) => {
      app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
      });
    })
    .catch((err) => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
