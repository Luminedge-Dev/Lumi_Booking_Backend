// One-off, read-only DB inspector for the Home-based eligibility rule.
// Prints the exact strings we must match: course names, any existing
// homeBasedSystems values, and the distinct "system" values found on real
// bookings/mocks (so we know whether the field is testSystem or testType and
// the exact spelling, e.g. "Computer-Based" vs "Computer-delivered").
//
// Usage (from repo root, with MONGODB_URI set in .env or the environment):
//   node scripts/inspect-courses.js
require("dotenv").config();
const { MongoClient } = require("mongodb");

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db("luminedge");

    console.log("\n=== courses (name + homeBasedSystems) ===");
    const courses = await db
      .collection("courses")
      .find({}, { projection: { name: 1, homeBasedSystems: 1 } })
      .toArray();
    courses.forEach((c) =>
      console.log(
        `  _id=${c._id}  name=${JSON.stringify(c.name)}  homeBasedSystems=${JSON.stringify(
          c.homeBasedSystems
        )}`
      )
    );

    console.log("\n=== bookingMock: distinct name / testType / testSystem ===");
    for (const f of ["name", "testType", "testSystem"]) {
      const vals = await db.collection("bookingMock").distinct(f);
      console.log(`  ${f}: ${JSON.stringify(vals)}`);
    }

    console.log("\n=== users.mocks: distinct mockType / testType / testSystem ===");
    for (const f of ["mockType", "testType", "testSystem"]) {
      const vals = await db.collection("users").distinct(`mocks.${f}`);
      console.log(`  mocks.${f}: ${JSON.stringify(vals)}`);
    }

    console.log("\nDone (no changes were made).");
  } catch (err) {
    console.error("Inspect failed:", err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
