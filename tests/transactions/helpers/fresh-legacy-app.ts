import type { MongoClient } from "mongodb";
import type { AppCollections } from "../../../src/app/database/database.types";

// Mirrors tests/characterization/schedule.contract.test.ts's freshApp()
// require-cache-busting pattern, extended to the FULL known-safe list of
// legacy singleton modules app.js mounts -- not just the one or two a given
// test happens to exercise. routes/booking.routes.js and
// routes/feedback.routes.js both have the same module-level Router()
// singleton bug as every other routes/*.routes.js file (const router =
// Router() at module scope, factory reuses it on every call); requiring a
// fresh app.js re-runs every route factory against whatever router object
// is currently cached, so busting only some of them risks a route file
// accumulating duplicate handlers across the many
// freshLegacyTransactionApp() calls this one test file will make.
// middleware/auth.js's own module-level `usersCollection` singleton doesn't
// strictly need busting for correctness in this serial
// (--test-concurrency=1), single-file suite, but is included for
// defense-in-depth consistency with the pattern
// auth-endpoints.contract.test.ts already uses for middleware/rateLimit.js.
const SINGLETON_MODULES = [
  "../../../app",
  "../../../routes/auth.routes",
  "../../../routes/user.routes",
  "../../../routes/booking.routes",
  "../../../routes/feedback.routes",
  "../../../routes/stats.routes",
  "../../../routes/schedule.routes",
  "../../../middleware/auth",
  "../../../middleware/rateLimit",
];

export function freshLegacyTransactionApp(collections: AppCollections, client: MongoClient) {
  for (const mod of SINGLETON_MODULES) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createApp = require("../../../app");
  return createApp({ ...collections, client });
}
