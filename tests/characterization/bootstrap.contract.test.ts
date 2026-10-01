// Characterization of the current index.js bootstrap behavior.
// Child processes run with explicit test-safe env only: no inherited real
// secrets, no MongoDB connection, no handler invocation, no port binding.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";

const BACKEND_DIR = path.resolve(__dirname, "..", "..");

// Minimal environment a Windows/Node child needs; everything else is set
// explicitly per case so local developer config can never leak in.
function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  return env;
}

function runNode(
  script: string,
  env: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["-e", script],
      { cwd: BACKEND_DIR, env, timeout: 30000 },
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

describe("bootstrap contract (characterization)", () => {
  // NOTE (characterization, verified 2026-10-01): index.js requires
  // ./config/db BEFORE validateEnv() runs, and config/db.js constructs
  // `new MongoClient(process.env.MONGODB_URI)` at import time. An empty URI
  // therefore throws MongoParseError during module load and validateEnv()
  // is never reached. Only the JWT secrets reliably reach the fail-fast path.
  it("fails fast when JWT secrets are absent", async () => {
    const result = await runNode("require('./index.js')", {
      ...minimalEnv(),
      MONGODB_URI: "mongodb://127.0.0.1:27017/luminedge",
      JWT_SECRET: "",
      JWT_RESET_PASS_SECRET: "",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing required environment variable/);
    assert.match(result.stderr, /JWT_SECRET/);
    assert.match(result.stderr, /JWT_RESET_PASS_SECRET/);
    assert.ok(
      !/MONGODB_URI/.test(result.stderr),
      "dummy URI is accepted; only JWT vars are reported missing"
    );
  });

  it("empty MONGODB_URI fails during db module load, before env validation", async () => {
    const result = await runNode("require('./index.js')", {
      ...minimalEnv(),
      MONGODB_URI: "",
      JWT_SECRET: "",
      JWT_RESET_PASS_SECRET: "",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Invalid scheme/);
  });

  it("exports a request handler without binding a port or starting cron", async () => {
    const result = await runNode(
      "const handler = require('./index.js'); console.log('EXPORT_TYPE:' + typeof handler);",
      {
        ...minimalEnv(),
        VERCEL: "1",
        MONGODB_URI: "mongodb://127.0.0.1:27017/luminedge",
        JWT_SECRET: "test-only-secret",
        JWT_RESET_PASS_SECRET: "test-reset-only-secret",
      }
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /EXPORT_TYPE:function/);
  });
});
