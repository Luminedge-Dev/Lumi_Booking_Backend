const { MongoClient } = require("mongodb");

// Serverless-tuned so a bad connection fails fast (well under Vercel's hard
// 10s function budget) instead of hanging on the driver's defaults
// (serverSelectionTimeoutMS 30000, socketTimeoutMS unbounded) — that's what
// turned an Atlas TLS reset into a wall of platform-level 504s instead of a
// clean, fast Mongo error. Exported so any other MongoClient in this repo
// (e.g. scripts/ensure-indexes.js) can share the same tuning instead of
// falling back to the driver's slower defaults.
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
};

const client = new MongoClient(process.env.MONGODB_URI, MONGO_CLIENT_OPTIONS);

let db;
let isHealthy = false;

// Driver-level signals that the shared connection is broken. `connectionPoolCleared`
// is exactly the event behind the "Connection pool ... was cleared" log line from
// the incident. Only connectivity is tracked here, not app-level query errors (e.g.
// duplicate key) — those aren't a sign the client itself is broken.
client.on("close", () => { isHealthy = false; });
client.on("error", () => { isHealthy = false; });
client.on("topologyClosed", () => { isHealthy = false; });
client.on("serverHeartbeatFailed", () => { isHealthy = false; });
client.on("connectionPoolCleared", () => { isHealthy = false; });

async function connectDB() {
  await client.connect();
  db = client.db("luminedge");
  isHealthy = true;
  return db;
}

// Call once per request (index.js). No-op when healthy. When a prior request
// left the shared pool wedged, this closes and reopens the SAME client
// instance so this request recovers instead of hanging behind a dead socket.
// Every Collection object already handed to route closures (see app.js)
// forwards through this same `client` reference at call time, so nothing
// else needs to be rebuilt or re-wired.
async function ensureHealthy() {
  if (isHealthy) return;
  console.warn("⚠️  Mongo connection unhealthy — reconnecting before serving request.");
  try {
    await client.close(true);
  } catch (err) {
    console.error("Error closing stale Mongo client:", err.message);
  }
  await connectDB();
}

function getCollections() {
  if (!db) throw new Error("Database not connected. Call connectDB() first.");
  return {
    usersCollection: db.collection("users"),
    coursesCollection: db.collection("courses"),
    schedulesCollection: db.collection("schedules"),
    bookingMockCollection: db.collection("bookingMock"),
  };
}

module.exports = { client, connectDB, getCollections, ensureHealthy, MONGO_CLIENT_OPTIONS };
