// Phase 0 safety baseline — read-only. Does NOT create, modify, or drop any
// index, and does not write anything to the database. Two things only:
//
//   1. Live index export: lists every actual index per collection and diffs
//      it against config/indexDefinitions.js's INDEX_SPECS (the same
//      order-independent keySignature comparison scripts/ensure-indexes.js
//      already uses — reused here rather than reinvented).
//   2. Transaction-topology verification: runs `hello` (falling back to the
//      legacy `isMaster` alias on older servers) to determine whether this
//      deployment is a replica set / sharded cluster (transaction-capable) or
//      a standalone (transactions unsupported) — the four existing
//      transactional routes (Home booking, Test Center booking, cancellation,
//      Home teacher assignment) depend on this being true.
//
// Output is written to context/evidence/phase0-live-topology-<timestamp>.txt
// (git-ignored evidence output, not printed in full to the console) plus a
// short summary on stdout.
//
// Usage:  node scripts/phase0-topology-check.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { INDEX_SPECS } = require("../config/indexDefinitions");
const { MONGO_CLIENT_OPTIONS } = require("../config/db");

const keySignature = (key) =>
  JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }

  const lines = [];
  const log = (s = "") => {
    lines.push(s);
  };

  const client = new MongoClient(process.env.MONGODB_URI, MONGO_CLIENT_OPTIONS);
  try {
    log(`Phase 0 topology/index check — ${new Date().toISOString()}`);
    log("Read-only. No createIndex/write of any kind was executed.");
    log("");

    await client.connect();
    const db = client.db("luminedge");

    // --- Transaction topology ---
    log("=== Transaction topology ===");
    let hello;
    try {
      hello = await db.admin().command({ hello: 1 });
    } catch (err) {
      // Older MongoDB versions (<5.0) don't support `hello`; fall back to isMaster.
      hello = await db.admin().command({ isMaster: 1 });
    }
    const isReplicaSet = Boolean(hello.setName) || hello.msg === "isdbgrid";
    const isMongos = hello.msg === "isdbgrid";
    log(`  setName:          ${hello.setName ?? "(none)"}`);
    log(`  msg:              ${hello.msg ?? "(none)"}`);
    log(`  isWritablePrimary/ismaster: ${hello.isWritablePrimary ?? hello.ismaster}`);
    log(`  maxWireVersion:   ${hello.maxWireVersion}`);
    log(
      `  => ${
        isMongos
          ? "Sharded cluster (mongos) — transaction-capable."
          : isReplicaSet
          ? "Replica set — transaction-capable."
          : "STANDALONE — transactions are NOT supported. The four existing " +
            "transactional routes (booking, cancellation, teacher assignment) " +
            "would fail with a server-side transaction error on this topology."
      }`
    );
    log("");

    // --- Live index export + diff against code ---
    log("=== Live indexes vs config/indexDefinitions.js ===");
    const collectionNames = ["users", "courses", "schedules", "bookingMock"];
    for (const name of collectionNames) {
      let existing = [];
      try {
        existing = await db.collection(name).listIndexes().toArray();
      } catch (err) {
        // "ns does not exist" (or similar) means the collection has never been
        // created on this database — report it as a finding, not a crash.
        log(`  --- ${name}: COLLECTION DOES NOT EXIST on this connection's db (${err.message}) ---`);
        log("");
        continue;
      }
      log(`  --- ${name} (${existing.length} live indexes) ---`);
      for (const idx of existing) {
        log(
          `    live: ${idx.name}  key=${keySignature(idx.key)}${
            idx.unique ? "  UNIQUE" : ""
          }`
        );
      }

      const expected = INDEX_SPECS.filter((spec) => spec.collection === name);
      const missing = expected.filter(
        (spec) =>
          !existing.some(
            (idx) =>
              keySignature(idx.key) === keySignature(spec.key) &&
              (!spec.options?.unique || idx.unique === true)
          )
      );
      if (missing.length) {
        for (const spec of missing) {
          log(
            `    ✗ MISSING per config/indexDefinitions.js: ${keySignature(spec.key)} ${
              spec.options ? JSON.stringify(spec.options) : ""
            }`
          );
        }
      } else if (expected.length) {
        log(`    ✓ all ${expected.length} code-defined indexes for ${name} are present live`);
      } else {
        log(`    (no code-defined indexes target this collection)`);
      }
      log("");
    }

    const outDir = path.join(__dirname, "..", "..", "context", "evidence");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(
      outDir,
      `phase0-live-topology-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`
    );
    fs.writeFileSync(outPath, lines.join("\n"), "utf8");

    console.log(`Done (read-only). Full report written to: ${outPath}`);
    console.log("");
    console.log("--- Summary ---");
    console.log(
      isMongos || isReplicaSet
        ? "Transaction topology: TRANSACTION-CAPABLE (replica set/mongos)."
        : "Transaction topology: STANDALONE — transactions unsupported."
    );
  } catch (err) {
    console.error("Topology check failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
