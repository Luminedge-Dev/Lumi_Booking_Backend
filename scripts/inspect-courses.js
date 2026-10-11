require("dotenv").config();
const { MongoClient } = require("mongodb");
const { databaseName } = require("../config/databaseName");

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(databaseName());

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
