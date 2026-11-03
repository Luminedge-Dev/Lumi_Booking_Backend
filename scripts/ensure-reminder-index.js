"use strict";

/**
 * Narrowly scoped, idempotent index migration for reminderDeliveries ONLY.
 * Operates strictly on reminderDeliveries collection; never touches users,
 * bookings, schedules, or courses.
 *
 * Verifies database identity, checks for existing indexes and duplicate keys,
 * creates { scheduleId: 1, userId: 1 } (unique: true) if missing, and verifies
 * post-creation status.
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");
const { MONGO_CLIENT_OPTIONS } = require("../config/db");
const { databaseName } = require("../config/databaseName");

const REQUIRED_INDEX_SPEC = {
  key: { scheduleId: 1, userId: 1 },
  options: { unique: true, name: "uniq_reminder_schedule_user" },
};

function keySignature(key) {
  return JSON.stringify(Object.entries(key || {}).sort(([a], [b]) => a.localeCompare(b)));
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI is not set.");
    process.exit(1);
  }

  const dbName = databaseName();
  console.log(`Target Database: "${dbName}"`);

  // Target confirmation safety check
  const isAuthorizedDev = dbName === "luminedge" || process.env.ALLOW_REMINDER_INDEX_MIGRATION === "true";
  if (!isAuthorizedDev) {
    console.error(`❌ Target database "${dbName}" is not authorized for standalone index migration without ALLOW_REMINDER_INDEX_MIGRATION=true.`);
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI, MONGO_CLIENT_OPTIONS);

  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    const db = client.db(dbName);

    const collections = await db.listCollections().toArray();
    const collNames = new Set(collections.map((c) => c.name));
    const collectionExists = collNames.has("reminderDeliveries");

    const collection = db.collection("reminderDeliveries");

    if (collectionExists) {
      console.log("Collection reminderDeliveries exists. Checking for duplicates...");
      const duplicates = await collection.aggregate([
        { $group: { _id: { scheduleId: "$scheduleId", userId: "$userId" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 }, "_id.scheduleId": { $ne: null }, "_id.userId": { $ne: null } } },
      ]).toArray();

      if (duplicates.length > 0) {
        console.error(`❌ Cannot create unique index: ${duplicates.length} duplicate {scheduleId, userId} pair(s) found.`);
        process.exitCode = 1;
        return;
      }

      const existingIndexes = await collection.listIndexes().toArray();
      const targetSig = keySignature(REQUIRED_INDEX_SPEC.key);
      const alreadyPresent = existingIndexes.some(
        (idx) => keySignature(idx.key) === targetSig && idx.unique === true && !idx.sparse && !idx.partialFilterExpression
      );

      if (alreadyPresent) {
        console.log("✅ Required unique index { scheduleId: 1, userId: 1 } is already present and verified.");
        return;
      }
    } else {
      console.log("Collection reminderDeliveries does not exist yet; will be created on index creation.");
    }

    console.log("Creating required unique compound index { scheduleId: 1, userId: 1 }...");
    await collection.createIndex(REQUIRED_INDEX_SPEC.key, REQUIRED_INDEX_SPEC.options);
    console.log("Index creation requested. Verifying...");

    const updatedIndexes = await collection.listIndexes().toArray();
    const targetSig = keySignature(REQUIRED_INDEX_SPEC.key);
    const verified = updatedIndexes.find(
      (idx) => keySignature(idx.key) === targetSig && idx.unique === true && !idx.sparse && !idx.partialFilterExpression
    );

    if (!verified) {
      console.error("❌ Post-creation verification failed: index not found with required properties.");
      process.exitCode = 1;
      return;
    }

    console.log("✅ Verified index:", JSON.stringify({ name: verified.name, key: verified.key, unique: verified.unique }));
    console.log("✅ reminderDeliveries index migration completed successfully.");
  } catch (err) {
    console.error("❌ Index migration error:", err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
    console.log("MongoDB connection closed.");
  }
}

if (require.main === module) {
  run();
}

module.exports = { run, REQUIRED_INDEX_SPEC };

