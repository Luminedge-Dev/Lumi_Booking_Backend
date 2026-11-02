require("dotenv").config();
const { MongoClient } = require("mongodb");
const { getIndexOps, INDEX_SPECS } = require("../config/indexDefinitions");
const { MONGO_CLIENT_OPTIONS } = require("../config/db");
const { databaseName } = require("../config/databaseName");

const keySignature = (key) =>
  JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI, MONGO_CLIENT_OPTIONS);
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    const db = client.db(databaseName());
    const collectionsByName = {
      users: db.collection("users"),
      bookingMock: db.collection("bookingMock"),
      schedules: db.collection("schedules"),
      reminderDeliveries: db.collection("reminderDeliveries"),
    };

    console.log("Creating/verifying indexes...");
    const creationErrors = [];
    for (const op of getIndexOps({
      usersCollection: collectionsByName.users,
      bookingMockCollection: collectionsByName.bookingMock,
      schedulesCollection: collectionsByName.schedules,
      reminderDeliveriesCollection: collectionsByName.reminderDeliveries,
    })) {
      try {
        await op();
      } catch (err) {
        creationErrors.push(err.message);
        console.error(`  ✗ index creation failed: ${err.message}`);
      }
    }

    let allVerified = true;
    for (const [name, collection] of Object.entries(collectionsByName)) {
      const expected = INDEX_SPECS.filter((spec) => spec.collection === name);
      const existing = await collection.listIndexes().toArray();
      const missing = expected.filter(
        (spec) =>
          !existing.some(
            (idx) =>
              keySignature(idx.key) === keySignature(spec.key) &&
              (!spec.options?.unique || idx.unique === true)
          )
      );

      console.log(`  ${name}: ${expected.length - missing.length}/${expected.length} indexes verified`);
      if (missing.length) {
        allVerified = false;
        for (const spec of missing) {
          console.error(`    ✗ missing/mismatched index on ${name}:`, keySignature(spec.key), spec.options ?? "");
        }
      }
    }

    if (!allVerified || creationErrors.length) {
      throw new Error(
        `Index migration incomplete: ${creationErrors.length} creation error(s), see report above.`
      );
    }

    console.log("✅ All indexes verified successfully.");
  } catch (err) {
    console.error("Index creation failed:", err.message);
    process.exitCode = 1;
  } finally {
    console.log("Closing MongoDB connection.");
    await client.close();
  }
})();
