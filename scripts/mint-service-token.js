// One-off: mint a long-lived JWT for an existing staff account, for use as a
// server-to-server service credential (e.g. the CRM backend's calls into
// this API). Reuses the exact token shape routes/auth.routes.js's login
// handler signs ({ email, userId, role }, JWT_SECRET) — no new auth
// mechanism, just a longer expiresIn suited to a machine credential instead
// of a human session.
//
// Usage:  node scripts/mint-service-token.js <staff-email> [expiresIn]
//   staff-email  required. Must belong to a user with role admin/bdm/teacher
//                (the same set middleware/auth.js's verifyStaff accepts).
//   expiresIn    optional jsonwebtoken expiresIn value. Defaults to "365d".
//
// Prints the token to stdout only — never written to a file or logged
// elsewhere. Copy it into the consuming service's env vars directly.
//
// Note: middleware/auth.js's checkAccountState invalidates any token issued
// before the account's passwordChangedAt. If that staff member's password is
// ever changed, this service token stops working and needs to be re-minted —
// prefer an account not used for day-to-day human login.
require("dotenv").config();
const { MongoClient } = require("mongodb");
const jwt = require("jsonwebtoken");

const STAFF_ROLES = ["admin", "bdm", "teacher"];

(async () => {
  const email = process.argv[2];
  const expiresIn = process.argv[3] || "365d";

  if (!email) {
    console.error("Usage: node scripts/mint-service-token.js <staff-email> [expiresIn]");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.error("MONGODB_URI and JWT_SECRET must be set (run against the target environment's .env).");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const usersCollection = client.db("luminedge").collection("users");

    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    if (!user) {
      console.error(`No user found with email ${email}`);
      process.exit(1);
    }
    if (!STAFF_ROLES.includes(user.role)) {
      console.error(`User ${email} has role "${user.role}" — must be one of ${STAFF_ROLES.join(", ")}.`);
      process.exit(1);
    }

    const token = jwt.sign(
      { email: user.email, userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    console.log(token);
  } finally {
    await client.close();
  }
})();
