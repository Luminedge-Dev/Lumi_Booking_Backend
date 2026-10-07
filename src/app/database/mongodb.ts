import { MongoClient, type Db } from "mongodb";

// Lazily constructed: config/db.js builds its client eagerly at import, so it cannot be imported here.
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

// No-op when healthy; otherwise reopens the same client so a wedged pool recovers in place.
export async function ensureHealthy(uri: string): Promise<void> {
  if (isHealthy) return;
  console.warn("⚠️  Mongo connection unhealthy — reconnecting before serving request.");
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
