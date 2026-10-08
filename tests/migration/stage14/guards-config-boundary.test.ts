// Stage 14 -- safety guards: write-target verification, CLI parsing, and static
// boundaries (Mongo is read-only; dry-run cannot reach PostgreSQL; no DDL).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../../../scripts/migration/stage14/config";
import { STAGE13_DEV_ENDPOINT_ID, StopError, verifyStage13Target } from "../../../scripts/migration/stage14/guards";

const POOLED = `postgresql://user:SECRETPW@${STAGE13_DEV_ENDPOINT_ID}-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const DIRECT = `postgresql://user:SECRETPW@${STAGE13_DEV_ENDPOINT_ID}.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const PROD_POOLED = "postgresql://user:SECRETPW@ep-falling-brook-a1b2c3d4-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require";
const PROD_DIRECT = "postgresql://user:SECRETPW@ep-falling-brook-a1b2c3d4.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require";

function stopMessage(env: { NEON_DB_URL?: string; NEON_DIRECT_URL?: string }): string {
  try {
    verifyStage13Target(env);
  } catch (error) {
    assert.ok(error instanceof StopError);
    return error.message;
  }
  assert.fail("expected a StopError");
}

describe("Stage 14 write-target guard", () => {
  it("accepts exactly the pooled+direct pair of the approved stage13-dev endpoint", () => {
    const target = verifyStage13Target({ NEON_DB_URL: POOLED, NEON_DIRECT_URL: DIRECT });
    assert.equal(target.branch, "stage13-dev");
    assert.equal(target.endpointId, STAGE13_DEV_ENDPOINT_ID);
  });

  it("refuses a production endpoint, a missing URL, swapped roles, a non-Neon host, a wrong database and a different endpoint", () => {
    assert.match(stopMessage({ NEON_DB_URL: PROD_POOLED, NEON_DIRECT_URL: PROD_DIRECT }), /production endpoint/);
    assert.match(stopMessage({ NEON_DB_URL: POOLED }), /both required/);
    assert.match(stopMessage({}), /both required/);
    assert.match(stopMessage({ NEON_DB_URL: DIRECT, NEON_DIRECT_URL: POOLED }), /pooled endpoint/);
    assert.match(stopMessage({ NEON_DB_URL: "postgresql://u:p@db.example.com/neondb", NEON_DIRECT_URL: "postgresql://u:p@db.example.com/neondb" }), /Neon/);
    assert.match(stopMessage({ NEON_DB_URL: POOLED.replace("/neondb", "/other"), NEON_DIRECT_URL: DIRECT.replace("/neondb", "/other") }), /database name/);
    assert.match(stopMessage({ NEON_DB_URL: POOLED.replace(STAGE13_DEV_ENDPOINT_ID, "ep-some-other-branch-1"), NEON_DIRECT_URL: DIRECT.replace(STAGE13_DEV_ENDPOINT_ID, "ep-some-other-branch-1") }), /approved stage13-dev/);
    assert.match(stopMessage({ NEON_DB_URL: "not a url", NEON_DIRECT_URL: DIRECT }), /malformed/);
  });

  it("never echoes a connection string or credential in a refusal", () => {
    for (const env of [{ NEON_DB_URL: PROD_POOLED, NEON_DIRECT_URL: PROD_DIRECT }, { NEON_DB_URL: POOLED, NEON_DIRECT_URL: PROD_DIRECT }, { NEON_DB_URL: "bad" }]) {
      const message = stopMessage(env);
      assert.ok(!message.includes("SECRETPW") && !message.includes("postgresql://") && !message.includes("neon.tech"));
    }
  });
});

describe("Stage 14 CLI configuration", () => {
  const env = { MONGODB_URI: "mongodb://127.0.0.1:1/x" } as NodeJS.ProcessEnv;

  it("parses dry-run with safe defaults and no write acknowledgement", () => {
    const c = parseArgs(["dry-run"], env);
    assert.equal(c.mode, "dry-run");
    assert.equal(c.batchSize, 500);
    assert.equal(c.userBatchSize, 100);
    assert.equal(c.targetAck, undefined);
    assert.equal(c.limit, undefined);
  });

  it("rejects unknown modes, a missing source URI, and sample/resume flags in the wrong mode", () => {
    assert.throws(() => parseArgs(["wipe"], env), /usage/);
    assert.throws(() => parseArgs([], env), /usage/);
    assert.throws(() => parseArgs(["dry-run"], {} as NodeJS.ProcessEnv), /MONGODB_URI/);
    assert.throws(() => parseArgs(["load", "--limit", "5"], env), /only allowed with dry-run/);
    assert.throws(() => parseArgs(["reconcile", "--limit", "5"], env), /only allowed with dry-run/);
    assert.throws(() => parseArgs(["dry-run", "--resume-from", "users"], env), /only meaningful with load/);
  });

  it("validates numeric flags, run ids and resume tokens", () => {
    assert.throws(() => parseArgs(["dry-run", "--batch-size", "0"], env), /positive integer/);
    assert.throws(() => parseArgs(["dry-run", "--batch-size", "x"], env), /positive integer/);
    assert.throws(() => parseArgs(["dry-run", "--run-id", "../evil"], env), /--run-id/);
    assert.throws(() => parseArgs(["load", "--resume-from", "nonsense"], env), /entity must be one of/);
    assert.throws(() => parseArgs(["load", "--resume-from", "users:objectId:zz"], env), /24-hex/);
    const ok = parseArgs(["load", "--target", "stage13-dev", "--resume-from", "bookingMock:objectId:650000000000000000000050", "--run-id", "r-1"], env);
    assert.equal(ok.targetAck, "stage13-dev");
    assert.deepEqual(ok.resumeFrom, { entity: "bookingMock", token: { bracket: "objectId", last: "650000000000000000000050" } });
  });
});

describe("Stage 14 runner refuses to write without the explicit, verified target", () => {
  function runner(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, ["--import=tsx", "scripts/migration/stage14/runner.ts", ...args], {
      cwd: path.resolve(__dirname, "../../.."),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("load without --target stage13-dev exits non-zero before touching any database", () => {
    const r = runner(["load"], { MONGODB_URI: "mongodb://127.0.0.1:1/x", NEON_DB_URL: POOLED, NEON_DIRECT_URL: DIRECT });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires the explicit acknowledgement/);
    assert.ok(!r.stderr.includes("SECRETPW") && !r.stdout.includes("SECRETPW"));
  });

  it("load/reconcile pointed at a production endpoint exits non-zero with a STOP and prints no credential", () => {
    for (const mode of ["load", "reconcile"]) {
      const r = runner([mode, "--target", "stage13-dev"], { MONGODB_URI: "mongodb://127.0.0.1:1/x", NEON_DB_URL: PROD_POOLED, NEON_DIRECT_URL: PROD_DIRECT });
      assert.equal(r.status, 1, mode);
      assert.match(r.stderr, /STOP: a production endpoint was detected/);
      assert.ok(!(r.stderr + r.stdout).includes("SECRETPW"));
    }
  });
});

// ---------------------------------------------------------------------------
// Static boundaries
// ---------------------------------------------------------------------------

const STAGE_DIR = path.resolve(__dirname, "../../../scripts/migration/stage14");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

function code(file: string): string {
  // strip comments so prose cannot trip or mask a check
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(STAGE_DIR, f).replace(/\\/g, "/");

describe("Stage 14 static boundaries", () => {
  const files = tsFiles(STAGE_DIR);

  it("finds the ETL sources", () => {
    assert.ok(files.length >= 15);
  });

  it("uses no MongoDB write, index or schema API anywhere outside the PostgreSQL loader", () => {
    const forbidden = /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|createIndex|createIndexes|dropIndex|dropIndexes|dropDatabase|dropCollection|createCollection|deleteOne|deleteMany|startSession|withTransaction)\b/;
    for (const file of files) {
      if (rel(file).startsWith("load/")) continue;
      assert.ok(!forbidden.test(code(file)), `${rel(file)} references a write-capable API`);
    }
  });

  it("imports the mongodb driver only in the read-only source wrapper (plus ObjectId/typing in common.ts)", () => {
    for (const file of files) {
      const importsMongo = /from\s+["']mongodb["']/.test(code(file));
      if (rel(file) === "extract/source.ts" || rel(file) === "common.ts") continue;
      assert.ok(!importsMongo, `${rel(file)} imports mongodb`);
    }
    assert.ok(!/MongoClient/.test(code(path.join(STAGE_DIR, "common.ts"))));
  });

  it("the read-only wrapper exposes no driver handle and no write method", () => {
    const src = code(path.join(STAGE_DIR, "extract/source.ts"));
    assert.ok(!/return\s+(client|db|collection)\s*[;,}]/.test(src));
    assert.ok(/countDocuments/.test(src) && /\.find\(/.test(src));
  });

  it("does not import the PostgreSQL client or loader statically from anything the dry-run path uses", () => {
    // `import type` is erased at compile time, so it cannot load PostgreSQL code at runtime.
    const staticImport = /^import(?!\s+type\b)[^;]*from\s+["']([^"']+)["']/gm;
    const dryRunFiles = files.filter((f) => !rel(f).startsWith("load/") && !rel(f).startsWith("reconcile/"));
    for (const file of dryRunFiles) {
      const text = code(file);
      for (const m of text.matchAll(staticImport)) {
        const spec = m[1]!;
        assert.ok(!/prisma|@prisma|database\/prisma|\/load\/loader|reconcile\/reconcile|target-reader/.test(spec), `${rel(file)} statically imports ${spec}`);
      }
    }
    const runner = code(path.join(STAGE_DIR, "runner.ts"));
    assert.match(runner, /await import\("\.\.\/\.\.\/\.\.\/src\/app\/database\/prisma\.js"\)/);
    assert.match(runner, /await import\("\.\/load\/loader\.js"\)/);
  });

  it("the loader does not import mongodb, and neither loader nor reconciliation issues DDL or schema-pushing commands", () => {
    for (const file of files.filter((f) => rel(f).startsWith("load/") || rel(f).startsWith("reconcile/"))) {
      const text = code(file);
      assert.ok(!/from\s+["']mongodb["']/.test(text), `${rel(file)} imports mongodb`);
      assert.ok(!/\$executeRaw|\bCREATE\s+(TABLE|INDEX)|\bDROP\s+|\bALTER\s+TABLE|\bTRUNCATE\b|db push|migrate (reset|dev|deploy)/i.test(text), `${rel(file)} contains DDL or a schema command`);
    }
  });

  it("reconciliation is SELECT-only against PostgreSQL", () => {
    for (const file of files.filter((f) => rel(f).startsWith("reconcile/"))) {
      const text = code(file);
      assert.ok(!/\b(createMany|create|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(text), `${rel(file)} calls a Prisma write`);
      assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s/.test(text), `${rel(file)} contains a SQL write`);
    }
  });

  it("the ETL never creates Better Auth rows", () => {
    for (const file of files.filter((f) => rel(f).startsWith("transform/"))) {
      const text = code(file);
      assert.ok(!/\b(sessions|accounts|verifications)\b\s*[:=]/.test(text) || rel(file) === "transform/declared.ts", `${rel(file)} produces Better Auth rows`);
    }
  });

  it("does not log or print connection strings", () => {
    for (const file of files) {
      const text = code(file);
      assert.ok(!/(console\.\w+|log|stdout\.write|stderr\.write)\([^)]*(mongoUri|NEON_DB_URL|NEON_DIRECT_URL|MONGODB_URI)/.test(text), `${rel(file)} may print a connection string`);
    }
  });
});
