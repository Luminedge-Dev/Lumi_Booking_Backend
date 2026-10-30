const dns = require("dns");
const { MongoClient } = require("mongodb");

const LOOPBACK_DNS = new Set(["127.0.0.1", "::1"]);

// Node's c-ares resolver on Windows can ignore the adapter DNS (here
// 8.8.8.8 / 1.1.1.1) and fall back to 127.0.0.1. Nothing listens on that
// port, so a mongodb+srv URI dies in startup with querySrv ECONNREFUSED
// before Atlas is ever contacted. nslookup still works because it uses the
// Windows DNS client. Only replace the resolver when every server c-ares
// reports is loopback, so a normal host is left alone.
function repairUnreachableSrvResolver() {
  const servers = dns.getServers().map((server) => server.replace(/%.+$/, ""));
  if (servers.length === 0 || !servers.every((server) => LOOPBACK_DNS.has(server))) {
    return;
  }
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  console.warn(
    "DNS resolver was loopback-only and refusing SRV lookups; using 8.8.8.8 and 1.1.1.1."
  );
}

repairUnreachableSrvResolver();

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

const { databaseName } = require("./databaseName");

async function connectDB() {
  await client.connect();
  db = client.db(databaseName());
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
    reminderDeliveriesCollection: db.collection("reminderDeliveries"),
  };
}

module.exports = { client, connectDB, getCollections, ensureHealthy, databaseName, MONGO_CLIENT_OPTIONS };
