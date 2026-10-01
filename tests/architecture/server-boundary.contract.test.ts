// Proves importing src/server.ts has zero runtime side effects and exports the
// new independent lifecycle functions (startServer/registerProcessHandlers) —
// not a lazy index.js delegator. Mirrors
// tests/characterization/bootstrap.contract.test.ts's isolated-child-process
// pattern (minimal explicit env, nothing inherited) but deliberately omits
// MONGODB_URI/JWT_SECRET entirely: src/app/config/env.ts's getConfig() only
// validates when called, never at import time, so a clean, successful import
// here is proof the module load path never touches Mongo or env validation
// (and never touches config/db.js or index.js at all — this file imports neither).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { listenAsync } from "../../src/server";

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

describe("src/server.ts boundary (architecture)", () => {
  it("import succeeds with zero side effects even when no MONGODB_URI/JWT secrets are set, and exports the independent lifecycle functions", async () => {
    const result = await runTsxEval(
      "import('./src/server.ts').then((m) => { console.log('START:' + typeof m.startServer); console.log('HANDLERS:' + typeof m.registerProcessHandlers); });",
      minimalEnv()
    );
    assert.equal(result.code, 0, `expected clean exit, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /START:function/);
    assert.match(result.stdout, /HANDLERS:function/);
  });
});

describe("listenAsync (architecture)", () => {
  it("resolves once the server actually binds to an OS-assigned port", async () => {
    const server = http.createServer();
    try {
      const bound = await listenAsync(server, 0);
      assert.equal(bound, server);
      const address = bound.address();
      assert.ok(address && typeof address !== "string" && address.port > 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects with the underlying EADDRINUSE error instead of crashing, without a free-port-search race", async () => {
    const first = http.createServer();
    const second = http.createServer();
    try {
      await listenAsync(first, 0);
      const occupiedPort = (first.address() as AddressInfo).port;

      await assert.rejects(
        () => listenAsync(second, occupiedPort),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE"
      );
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });
});
