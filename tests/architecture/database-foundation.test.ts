// Structural/static verification only — no real MongoDB connection is made by
// this file. Proves: collection-name wiring, index-definition parity against the
// real config/indexDefinitions.js, and that merely importing mongodb.ts never
// constructs a MongoClient (zero import-time side effects, unlike config/db.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { createCollections } from "../../src/app/database/collections";
import { getIndexOps, INDEX_SPECS } from "../../src/app/database/indexes";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { INDEX_SPECS: LEGACY_INDEX_SPECS } = require("../../config/indexDefinitions");

const BACKEND_DIR = path.resolve(__dirname, "..", "..");

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  return env;
}

function runTsxEval(
  script: string,
  env: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { cwd: BACKEND_DIR, env, timeout: 15000 },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          const maybe = error as { code?: number | string };
          code = typeof maybe.code === "number" ? maybe.code : 1;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

describe("database collection wiring (architecture)", () => {
  it("createCollections calls db.collection with the four expected names", () => {
    const calls: string[] = [];
    const fakeDb = {
      collection(name: string) {
        calls.push(name);
        return { __name: name };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = createCollections(fakeDb);
    assert.deepEqual(calls, ["users", "courses", "schedules", "bookingMock"]);
    assert.equal((result.usersCollection as unknown as { __name: string }).__name, "users");
    assert.equal((result.coursesCollection as unknown as { __name: string }).__name, "courses");
    assert.equal((result.schedulesCollection as unknown as { __name: string }).__name, "schedules");
    assert.equal((result.bookingMockCollection as unknown as { __name: string }).__name, "bookingMock");
  });
});

describe("index-definition parity vs config/indexDefinitions.js (architecture)", () => {
  it("INDEX_SPECS matches the legacy source exactly (order, keys, options)", () => {
    assert.deepEqual(INDEX_SPECS, LEGACY_INDEX_SPECS);
  });

  it("getIndexOps executes one createIndex call per spec, matching the legacy collection/key/options exactly", async () => {
    const calls: Array<{ collection: string; key: unknown; options: unknown }> = [];
    function trackingCollection(name: string) {
      return {
        createIndex(key: unknown, options: unknown) {
          calls.push({ collection: name, key, options });
          return Promise.resolve(`${name}_index`);
        },
      };
    }
    const fakeCollections = {
      usersCollection: trackingCollection("users"),
      coursesCollection: trackingCollection("courses"),
      schedulesCollection: trackingCollection("schedules"),
      bookingMockCollection: trackingCollection("bookingMock"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const ops = getIndexOps(fakeCollections);
    assert.equal(ops.length, INDEX_SPECS.length);

    for (const op of ops) {
      await op();
    }

    assert.deepEqual(
      calls,
      LEGACY_INDEX_SPECS.map(
        ({ collection, key, options }: { collection: string; key: unknown; options?: unknown }) => ({
          collection,
          key,
          options,
        })
      )
    );
  });
});

describe("src/app/database/mongodb.ts import safety (architecture)", () => {
  it("importing mongodb.ts constructs no MongoClient even with no MONGODB_URI set", async () => {
    const result = await runTsxEval(
      "import('./src/app/database/mongodb.ts').then((m) => { console.log('IMPORT_OK:' + typeof m.connectMongoDB); });",
      minimalEnv()
    );
    assert.equal(result.code, 0, `expected clean exit, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /IMPORT_OK:function/);
  });
});
