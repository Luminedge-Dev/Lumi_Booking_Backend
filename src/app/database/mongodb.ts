import { MongoClient, type Db } from "mongodb";

// Independent of config/db.js on purpose: config/db.js constructs its MongoClient
// eagerly at module load (`new MongoClient(process.env.MONGODB_URI)` runs the
// instant the file is required), which is exactly what makes it unsafe to import
// from a side-effect-free module. This file mirrors its connection tuning and
// db name, but only constructs anything lazily, on first call.
//
// Configuration ownership stays centralized: this module takes the connection
// string as a parameter and never reads process.env itself. src/server.ts resolves
// it once via getConfig().mongodbUri and passes it in.
const MONGO_CLIENT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 8000,
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
  waitQueueTimeoutMS: 5000,
  retryWrites: true,
  retryReads: true,
} as const;

let client: MongoClient | undefined;
let db: Db | undefined;
let isHealthy = false;

function buildClient(uri: string): MongoClient {
  const c = new MongoClient(uri, MONGO_CLIENT_OPTIONS);
  c.on("close", () => { isHealthy = false; });
  c.on("error", () => { isHealthy = false; });
  c.on("topologyClosed", () => { isHealthy = false; });
  c.on("serverHeartbeatFailed", () => { isHealthy = false; });
  c.on("connectionPoolCleared", () => { isHealthy = false; });
  return c;
}

export function getMongoClient(uri: string): MongoClient {
  if (!client) {
    client = buildClient(uri);
  }
  return client;
}

export async function connectMongoDB(uri: string): Promise<Db> {
  const c = getMongoClient(uri);
  await c.connect();
  db = c.db("luminedge");
  isHealthy = true;
  return db;
}

export function getDatabase(): Db {
  if (!db) throw new Error("Database not connected. Call connectMongoDB() first.");
  return db;
}

// Mirrors config/db.js's ensureHealthy(): no-op when healthy, otherwise closes
// and reopens the same client instance so a wedged pool recovers in place.
export async function ensureHealthy(uri: string): Promise<void> {
  if (isHealthy) return;
  if (client) {
    try {
      await client.close(true);
    } catch {
      // ignore close errors on an already-broken client
    }
  }
  await connectMongoDB(uri);
}

export async function disconnectMongoDB(): Promise<void> {
  if (client) {
    await client.close();
  }
  client = undefined;
  db = undefined;
  isHealthy = false;
}
