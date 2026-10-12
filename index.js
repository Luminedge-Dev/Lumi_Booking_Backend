require("dotenv").config();
const { connectDB, getCollections, client, ensureHealthy } = require("./config/db");
const { getIndexOps } = require("./config/indexDefinitions");
const { startReminderCron } = require("./jobs/reminderCron");
const { smtpConnection } = require("./emailSender");
const createApp = require("./app");

function validateEnv() {
  const required = ["MONGODB_URI", "JWT_SECRET", "JWT_RESET_PASS_SECRET"];
  if (process.env.NODE_ENV === "production") {
    required.push("CORS_ORIGINS", "FRONTEND_URL", "RESET_PASS_LINK");
  }
  const missing = required.filter((k) => !String(process.env[k] || "").trim());
  if (missing.length) {
    console.error(`❌ Missing required environment variable(s): ${missing.join(", ")}`);
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  const smtpUser = process.env.EMAIL || process.env.SMTP_EMAIL;
  const smtpPass = process.env.APP_PASS || process.env.SMTP_APP_PASS;

  if (!process.env.SMTP_HOST) {
    console.warn("⚠️  SMTP_HOST is not set — outbound email will fail.");
  }
  if (!smtpUser || !smtpPass) {
    console.warn("⚠️  EMAIL/SMTP_EMAIL and/or APP_PASS/SMTP_APP_PASS is not set — SMTP authentication will fail.");
  }
  if (!process.env.EMAIL_FROM && !smtpUser) {
    console.warn("⚠️  Neither EMAIL_FROM nor EMAIL/SMTP_EMAIL is set — email 'from' address is undefined.");
  }

  const { port: smtpPort, requestedSecure } = smtpConnection();
  if (smtpPort === 465 && !requestedSecure) {
    console.warn("⚠️  SMTP_PORT=465 uses implicit TLS. SMTP_SECURE was not true; connecting with TLS anyway.");
  }
  if (smtpPort === 587 && requestedSecure) {
    console.warn("⚠️  SMTP_PORT=587 uses STARTTLS. SMTP_SECURE was true; connecting without implicit TLS.");
  }

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

let appPromise;

async function bootstrap() {
  await connectDB();

  const collections = { ...getCollections(), client };

  if (process.env.SKIP_INDEX_ENSURE_ON_BOOT !== "true") {
    ensureIndexes(collections).catch((err) =>
      console.error("Index creation failed:", err.message)
    );
  }

  if (!isServerless) {
    startReminderCron(collections.usersCollection);
  }

  return createApp(collections);
}

function getApp() {
  if (!appPromise) appPromise = bootstrap();
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    await ensureHealthy();
    return app(req, res);
  } catch (err) {
    console.error("Failed to initialize app:", err);
    appPromise = undefined;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Server initialization failed." }));
  }
};

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
