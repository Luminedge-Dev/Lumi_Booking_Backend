// Stage 12.5 runtime-boundary guards: the new serverless handler and shared
// bootstrap cache. No production Mongo, no .env credentials, no Prisma --
// every behavior here runs against injected fakes or in isolated child
// processes with a minimal explicit environment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import request from "supertest";
import express from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handler } from "../../src/handler";
import {
  getRuntimeInstance,
  resetRuntimeInstance,
  type RuntimeInstance,
} from "../../src/app/runtime/bootstrap";

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

function fakeRuntime(app: (req: IncomingMessage, res: ServerResponse) => unknown): RuntimeInstance {
  return {
    app: app as unknown as RuntimeInstance["app"],
    config: { mongodbUri: "mongodb://fake.invalid/db" } as RuntimeInstance["config"],
    collections: {} as RuntimeInstance["collections"],
    close: async () => undefined,
    ensureHealthy: async () => undefined,
  };
}

describe("src/handler.ts import (architecture)", () => {
  it("imports with zero side effects: no listen, no bootstrap, clean exit without any env", async () => {
    // NOTE: with tsconfig module Node16 and no package.json "type" field,
    // tsx loads .ts as CJS, so the default export arrives double-wrapped
    // (m.default.default); the named export is the bare function. Both
    // shapes must resolve to the function -- @vercel/node normalizes the
    // default shape at deploy time, unit tests use the named shape.
    const result = await runTsxEval(
      "import('./src/handler.ts').then((m) => { const d = m.default && m.default.default ? m.default.default : m.default; console.log('DEFAULT:' + typeof d); console.log('NAMED:' + typeof m.handler); });",
      minimalEnv()
    );
    assert.equal(result.code, 0, `expected clean exit, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /DEFAULT:function/);
    assert.match(result.stdout, /NAMED:function/);
  });

  it("importing the handler registers no process-lifecycle listeners (those belong to the long-lived entrypoint only)", async () => {
    const result = await runTsxEval(
      "import('./src/handler.ts').then(() => { console.log('SIGTERM:' + process.listenerCount('SIGTERM')); console.log('SIGINT:' + process.listenerCount('SIGINT')); console.log('UNCAUGHT:' + process.listenerCount('uncaughtException')); console.log('UNHANDLED:' + process.listenerCount('unhandledRejection')); });",
      minimalEnv()
    );
    assert.equal(result.code, 0, `expected clean exit, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /SIGTERM:0/);
    assert.match(result.stdout, /SIGINT:0/);
    assert.match(result.stdout, /UNCAUGHT:0/);
    assert.match(result.stdout, /UNHANDLED:0/);
  });

  it("handler source stays narrow: no listen, no cron, no Prisma/Postgres imports", () => {
    const source = readFileSync(path.join(BACKEND_DIR, "src", "handler.ts"), "utf8");
    // Import-shaped tokens only (prose may name what is forbidden).
    for (const token of ["listen(", "startLegacyReminderCron", "cron.schedule", "@prisma/", "from \"prisma\"", "from \"pg\"", "pgClient"]) {
      assert.ok(!source.includes(token), `src/handler.ts must not contain ${token}`);
    }
  });
});

describe("src/main.ts import (architecture)", () => {
  it("imports with zero side effects: no server starts, clean exit without any env", async () => {
    const result = await runTsxEval(
      "import('./src/main.ts').then((m) => { console.log('MAIN:' + typeof m.main); });",
      minimalEnv()
    );
    assert.equal(result.code, 0, `expected clean exit, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /MAIN:function/);
  });
});

describe("production entrypoint configuration (architecture)", () => {
  it("vercel.json targets the TS handler, and the legacy runtime is retained for rollback", () => {
    const vercel = JSON.parse(readFileSync(path.join(BACKEND_DIR, "vercel.json"), "utf8")) as {
      builds: Array<{ src: string }>;
      routes: Array<{ dest: string }>;
    };
    assert.ok(
      vercel.builds.some((b) => b.src === "src/handler.ts"),
      "vercel.json must build src/handler.ts"
    );
    assert.ok(
      vercel.routes.some((r) => r.dest === "src/handler.ts"),
      "vercel.json must route to src/handler.ts"
    );
    assert.ok(
      !vercel.builds.some((b) => b.src === "index.js") && !vercel.routes.some((r) => r.dest === "index.js"),
      "index.js must no longer be the configured production entrypoint"
    );
    // Rollback assets: the legacy runtime stays in the repo, untouched.
    for (const legacyFile of ["index.js", "app.js"]) {
      assert.ok(
        readFileSync(path.join(BACKEND_DIR, legacyFile), "utf8").length > 0,
        `${legacyFile} must remain in the repo for rollback`
      );
    }
  });

  it("package scripts run the TS runtime by default and keep legacy aliases", () => {
    const pkg = JSON.parse(readFileSync(path.join(BACKEND_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts.dev, /src\/main\.ts/);
    assert.match(pkg.scripts.start, /src\/main\.ts/);
    assert.match(pkg.scripts["dev:legacy"] ?? "", /index\.js/);
    assert.match(pkg.scripts["start:legacy"] ?? "", /index\.js/);
  });

  it("Prisma 7.10.0 is pinned and Better Auth, Mongoose, and pg are absent", () => {
    const pkg = JSON.parse(readFileSync(path.join(BACKEND_DIR, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.dependencies["@prisma/client"], "7.10.0");
    assert.equal(pkg.dependencies["@prisma/adapter-neon"], "7.10.0");
    assert.equal(pkg.devDependencies.prisma, "7.10.0");
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ["pg", "postgres", "@lucia-auth", "better-auth", "mongoose", "redis", "ioredis"]) {
      assert.ok(!(banned in all), `banned dependency present: ${banned}`);
    }
    assert.equal(pkg.scripts["prisma:generate"], "prisma generate");
    assert.ok(!("postinstall" in pkg.scripts), "Stage 13 does not add a postinstall hook");
  });
});

describe("warm-container cache (architecture)", () => {
  it("initializes once: concurrent and sequential callers share one instance", async () => {
    resetRuntimeInstance();
    try {
      let calls = 0;
      const instance = fakeRuntime((_req, res) => res.end("ok"));
      const init = async (): Promise<RuntimeInstance> => {
        calls += 1;
        return instance;
      };
      const [a, b] = await Promise.all([getRuntimeInstance(init), getRuntimeInstance(init)]);
      const c = await getRuntimeInstance(init);
      assert.equal(a, instance);
      assert.equal(b, instance);
      assert.equal(c, instance);
      assert.equal(calls, 1);
    } finally {
      resetRuntimeInstance();
    }
  });

  it("reset drops the cache so the next caller re-initializes", async () => {
    resetRuntimeInstance();
    try {
      let calls = 0;
      const init = async (): Promise<RuntimeInstance> => {
        calls += 1;
        return fakeRuntime((_req, res) => res.end("ok"));
      };
      await getRuntimeInstance(init);
      resetRuntimeInstance();
      await getRuntimeInstance(init);
      assert.equal(calls, 2);
    } finally {
      resetRuntimeInstance();
    }
  });

  it("failed bootstrap is retryable: rejection is not served forever, next request re-initializes", async () => {
    resetRuntimeInstance();
    try {
      await assert.rejects(
        getRuntimeInstance(async () => {
          throw new Error("simulated bootstrap failure");
        })
      );
      // Simulate the handler's failure path (reset on error), then prove a
      // healthy initializer is used for the retry.
      resetRuntimeInstance();
      let calls = 0;
      const healthy = fakeRuntime((_req, res) => res.end("ok"));
      const retried = await getRuntimeInstance(async () => {
        calls += 1;
        return healthy;
      });
      assert.equal(retried, healthy);
      assert.equal(calls, 1);
    } finally {
      resetRuntimeInstance();
    }
  });
});

describe("serverless handler dispatch (architecture)", () => {
  it("dispatches to the cached app after a health check", async () => {
    resetRuntimeInstance();
    try {
      const mini = express();
      mini.get("/ping", (_req, res) => res.json({ pong: true }));
      let recovered = false;
      const instance = fakeRuntime((_req, res) => res.end("unused"));
      const dispatchable: RuntimeInstance = {
        ...instance,
        app: mini as unknown as RuntimeInstance["app"],
        ensureHealthy: async () => {
          recovered = true;
        },
      };
      await getRuntimeInstance(async () => dispatchable);

      const res = await request(handler).get("/ping");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { pong: true });
      assert.equal(recovered, true);
    } finally {
      resetRuntimeInstance();
    }
  });

  it("failed initialization returns the existing safe 500 contract, not a crash or HTML page", async () => {
    resetRuntimeInstance();
    try {
      await getRuntimeInstance(async () => {
        throw new Error("simulated bootstrap failure");
      }).catch(() => undefined);

      const res = await request(handler).get("/");
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { message: "Server initialization failed." });
    } finally {
      resetRuntimeInstance();
    }
  });
});
