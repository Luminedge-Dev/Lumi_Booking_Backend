"use strict";

/**
 * Shared database-safety layer for the seven-fix hotfix test suites.
 *
 * These helpers exist so that no test file can be talked into running against a
 * shared, production or otherwise unintended MongoDB:
 *
 *   - the ONLY accepted target is a bare `mongodb://127.0.0.1:<port>`; SRV,
 *     credentialed, multi-host, IPv6, DNS-name and option-bearing URIs are all
 *     refused before a socket is opened;
 *   - the target must be an explicitly provisioned throwaway instance: the
 *     caller has to supply `HOTFIX_TEST_MONGODB_URI` (there is no default) and
 *     the port may not be 27017, the port the workstation's installed MongoDB
 *     *service* listens on — so a test can never silently become a production
 *     or "the machine happens to have Mongo running" test;
 *   - the client is created from a frozen option set that always includes
 *     `directConnection: true`, so seed lists / topology discovery can never
 *     redirect the driver elsewhere. Callers may NOT pass client options; a
 *     third argument is rejected instead of merged (merging is how
 *     `directConnection` used to be overridable);
 *   - after connecting, the server's own view of the client socket
 *     (`whatsmyuri`) must be a 127.0.0.1 address;
 *   - every database name must start with `lumi_hotfix_test_`, and the suite
 *     refuses to write into one that already contains collections.
 *
 * `.env` / `.env.test` are never loaded. Call `stripInheritedMongoEnv()` before
 * importing any application module so nothing can fall back to the configured
 * cluster by accident.
 *
 * Usage:
 *   const uri = resolveTestMongoUri();          // requires HOTFIX_TEST_MONGODB_URI
 *   const dbName = disposableDbName("fix01");
 *   stripInheritedMongoEnv();
 *   // ... require("../../app") here ...
 *   const { client, db } = await connectDisposable(uri, dbName);
 */

const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

const TEST_DB_PREFIX = "lumi_hotfix_test_";

// Documented for reference only: this is the port of the workstation's
// installed MongoDB service, so it is explicitly REFUSED as a test target.
const DEFAULT_LOOPBACK_URI = "mongodb://127.0.0.1:27017";
const SHARED_SERVICE_PORT = 27017;

// The single accepted shape. Everything the suites need (directConnection,
// timeouts) is set in code, so no query string is legitimate.
const STRICT_LOOPBACK_URI = /^mongodb:\/\/127\.0\.0\.1:(\d{1,5})$/;

// Frozen: nothing may add to, replace or spread-over these settings.
const SAFE_CLIENT_OPTIONS = Object.freeze({
  directConnection: true,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});

/**
 * Throws unless `raw` is exactly `mongodb://127.0.0.1:<port>`. Returns the
 * trimmed value unchanged. This is the *grammar* check only — it says nothing
 * about whether that port is a disposable instance (see
 * `assertDedicatedMongoTarget`).
 */
function assertLoopbackMongoUri(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) {
    throw new Error("Refusing to run: no MongoDB URI supplied.");
  }

  if (/^mongodb\+srv:\/\//i.test(value)) {
    throw new Error(
      "Refusing to run: mongodb+srv:// performs DNS service discovery and is never a local " +
        "test database. Use mongodb://127.0.0.1:<port>."
    );
  }
  if (!/^mongodb:\/\//.test(value)) {
    throw new Error(
      "Refusing to run: MongoDB URI must start with the literal scheme mongodb:// (loopback only)."
    );
  }

  const rest = value.slice("mongodb://".length);
  if (rest.includes("@")) {
    throw new Error("Refusing to run: credentialed MongoDB URIs are never accepted in tests.");
  }
  if (rest.includes(",")) {
    throw new Error(
      "Refusing to run: multi-host MongoDB URIs are rejected — a single explicit loopback " +
        "host is required."
    );
  }
  if (rest.includes("?") || rest.includes("#")) {
    throw new Error(
      "Refusing to run: MongoDB connection options are rejected. The harness sets " +
        "directConnection/timeout options itself; write a bare mongodb://127.0.0.1:<port> URI."
    );
  }
  if (rest.includes("/")) {
    throw new Error(
      "Refusing to run: the MongoDB URI must not name a database or contain a path. " +
        "These suites always target their own disposable database."
    );
  }

  const match = STRICT_LOOPBACK_URI.exec(value);
  if (!match) {
    const host = rest.split(":")[0] || "(missing)";
    throw new Error(
      `Refusing to run: only mongodb://127.0.0.1:<port> is accepted (got host "${host}"). ` +
        "Remote hosts, DNS names, IPv6 literals, wildcard addresses and missing ports are refused."
    );
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to run: MongoDB port "${match[1]}" is not in the range 1-65535.`);
  }

  return value;
}

/**
 * Grammar check PLUS the "dedicated instance" rule: the default MongoDB port
 * belongs to the machine's installed service, so it is refused outright. A
 * throwaway test instance always listens on an alternate loopback port.
 */
function assertDedicatedMongoTarget(raw) {
  const value = assertLoopbackMongoUri(raw);
  const port = Number(STRICT_LOOPBACK_URI.exec(value)[1]);
  if (port === SHARED_SERVICE_PORT) {
    throw new Error(
      `Refusing to run: port ${SHARED_SERVICE_PORT} is the default MongoDB port of the installed ` +
        "service on this workstation. Start a dedicated throwaway instance on an alternate " +
        "loopback port (e.g. 27018) with its own temporary --dbpath and point " +
        "HOTFIX_TEST_MONGODB_URI at it."
    );
  }
  return value;
}

/**
 * Resolve the target every suite must use. There is deliberately NO default: an
 * unset variable is an error, not a quiet fallback to 127.0.0.1:27017.
 */
function resolveTestMongoUri(raw) {
  const source = raw === undefined ? process.env.HOTFIX_TEST_MONGODB_URI : raw;
  const value = source == null ? "" : String(source).trim();
  if (!value) {
    throw new Error(
      "Refusing to run: HOTFIX_TEST_MONGODB_URI is not set. This suite never falls back to the " +
        "installed MongoDB service. Start a throwaway instance " +
        "(mongod --dbpath <temp> --port 27018 --bind_ip 127.0.0.1) and set " +
        "HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27018."
    );
  }
  return assertDedicatedMongoTarget(value);
}

/** Throws unless `name` is a unique disposable database name. */
function assertDisposableDbName(name) {
  if (typeof name !== "string" || !name.startsWith(TEST_DB_PREFIX)) {
    throw new Error(`Refusing to run: test database name must start with "${TEST_DB_PREFIX}".`);
  }
  if (name.length <= TEST_DB_PREFIX.length) {
    throw new Error("Refusing to run: test database name has no unique suffix.");
  }
  return name;
}

/** Build a fresh, unique, disposable database name for one suite. */
function disposableDbName(kind) {
  const safeKind = String(kind || "suite").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return assertDisposableDbName(
    `${TEST_DB_PREFIX}${safeKind}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`
  );
}

/** Remove inherited connection settings before application modules are loaded. */
function stripInheritedMongoEnv() {
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB_NAME;
}

/**
 * Connect to a disposable database, refusing to proceed unless the socket is a
 * local one, the port is a dedicated test instance and the database is still
 * empty.
 *
 * Signature is exactly `(uri, dbName)`. Any extra argument (historically a
 * client-options object that could override `directConnection`) is refused
 * rather than merged.
 */
async function connectDisposable(uri, dbName, ...extra) {
  if (extra.length > 0) {
    throw new Error(
      "Refusing to run: connectDisposable(uri, dbName) accepts no client options. Connection " +
        "safety settings are fixed by SAFE_CLIENT_OPTIONS and must not be overridable."
    );
  }

  const target = assertDedicatedMongoTarget(uri);
  assertDisposableDbName(dbName);

  // Fresh copy of the frozen defaults: the caller can never influence these.
  const client = new MongoClient(target, { ...SAFE_CLIENT_OPTIONS });
  await client.connect();
  const db = client.db(dbName);

  // The server's view of this connection must be loopback.
  const peer = await db.command({ whatsmyuri: 1 });
  if (!/^127\.0\.0\.1:\d+$/.test(String(peer.you || ""))) {
    await client.close();
    throw new Error(
      `Refusing to run: the server sees this client as "${peer.you}", not a 127.0.0.1 socket.`
    );
  }

  const hello = await db.command({ hello: 1 });
  if (hello.isWritablePrimary !== true && hello.ismaster !== true) {
    await client.close();
    throw new Error("Refusing to run: the target is not a writable primary.");
  }

  // A random name should never exist yet; never write over pre-existing data.
  const existing = await db.listCollections().toArray();
  if (existing.length > 0) {
    await client.close();
    throw new Error(
      `Refusing to run: disposable database "${dbName}" already has ${existing.length} ` +
        "collection(s); refusing to modify pre-existing data."
    );
  }

  return { client, db };
}

module.exports = {
  TEST_DB_PREFIX,
  DEFAULT_LOOPBACK_URI,
  SHARED_SERVICE_PORT,
  STRICT_LOOPBACK_URI,
  SAFE_CLIENT_OPTIONS,
  assertLoopbackMongoUri,
  assertDedicatedMongoTarget,
  resolveTestMongoUri,
  assertDisposableDbName,
  disposableDbName,
  stripInheritedMongoEnv,
  connectDisposable,
};
