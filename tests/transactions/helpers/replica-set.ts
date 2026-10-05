import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db } from "mongodb";
import { createCollections } from "../../../src/app/database/collections";
import { getIndexOps } from "../../../src/app/database/indexes";
import type { AppCollections } from "../../../src/app/database/database.types";

// Isolated, disposable MongoDB lifecycle for Stage 10's real-transaction
// test suite only -- never reads any production Mongo connection-string env
// var; the connection string comes exclusively from replSet.getUri(). No
// production/Atlas access of any kind.
export interface TransactionTestDb {
  replSet: MongoMemoryReplSet;
  client: MongoClient;
  db: Db;
  collections: AppCollections;
  reset(): Promise<void>;
  teardown(): Promise<void>;
}

// Binary version is explicitly pinned, not left to mongodb-memory-server's
// own default-resolution logic -- an unpinned harness can silently change
// behavior whenever that default changes. Verified at Build time to
// download and start on this Windows x64 / Node 24 machine.
const PINNED_MONGO_BINARY_VERSION = "7.0.14";

export async function startTransactionTestDb(): Promise<TransactionTestDb> {
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: PINNED_MONGO_BINARY_VERSION },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  // Startup is failure-safe, not just teardown-safe: if anything after the
  // replica set itself comes up fails (connect, index creation), a
  // partially-initialized client must not leak -- clean up whatever was
  // actually created, then rethrow the ORIGINAL error.
  let client: MongoClient | undefined;
  try {
    const uri = replSet.getUri();
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db(`luminedge_transaction_test_${Date.now()}`);
    const collections = createCollections(db);
    await Promise.all(getIndexOps(collections).map((op) => op()));

    const reset = async (): Promise<void> => {
      await Promise.all([
        collections.usersCollection.deleteMany({}),
        collections.coursesCollection.deleteMany({}),
        collections.schedulesCollection.deleteMany({}),
        collections.bookingMockCollection.deleteMany({}),
      ]);
    };

    const teardown = async (): Promise<void> => {
      try {
        await db.dropDatabase();
      } finally {
        try {
          await client!.close();
        } finally {
          await replSet.stop();
        }
      }
    };

    return { replSet, client, db, collections, reset, teardown };
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    try {
      await replSet.stop();
    } catch {
      // best-effort
    }
    throw err;
  }
}
