// Standalone version of index.js's ensureIndexes(), for running index
// creation as a deploy/migration step instead of on every serverless cold
// start. Run this once against an environment (e.g. right after deploying
// to a fresh database), then set SKIP_INDEX_ENSURE_ON_BOOT=true in that
// environment to stop index.js from also doing this on every cold start.
//
// Self-verifying: after attempting each index, it re-reads each collection's
// actual indexes via listIndexes() and confirms every expected key (and, for
// specs that require it, the `unique` option) from config/indexDefinitions.js
// is really present, rather than trusting that createIndex() not throwing
// means the index exists exactly as intended.
//
// One failing index doesn't stop the rest: each createIndex() is attempted
// independently, so a single bad index (e.g. a duplicate-key conflict on the
// unique email index) doesn't prevent the other 17 from being created, and
// the verification report below always runs so you can see exactly which
// index(es) need attention.
//
// Usage:  node scripts/ensure-indexes.js
require("dotenv").config();
const { MongoClient } = require("mongodb");
const { getIndexOps, INDEX_SPECS } = require("../config/indexDefinitions");
const { MONGO_CLIENT_OPTIONS } = require("../config/db");

// Order-independent so a compound key document returned by MongoDB in a
// different field order than the local spec literal still compares equal.
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
    const db = client.db("luminedge");
    const collectionsByName = {
      users: db.collection("users"),
      bookingMock: db.collection("bookingMock"),
      schedules: db.collection("schedules"),
    };

    console.log("Creating/verifying indexes...");
    const creationErrors = [];
    for (const op of getIndexOps({
      usersCollection: collectionsByName.users,
      bookingMockCollection: collectionsByName.bookingMock,
      schedulesCollection: collectionsByName.schedules,
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
