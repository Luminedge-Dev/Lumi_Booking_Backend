// Stage 5: unit/behavioral coverage for the new src/app/middleware/* modules
// in isolation, without going through the full createApp() composition.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { z } from "zod";
import {
  AUTH_LIMITER_POLICY,
  GLOBAL_LIMITER_POLICY,
  createAuthRateLimiter,
} from "../../src/app/middleware/rate-limit";
import { CORS_REJECTION_MESSAGE, createCorsMiddleware } from "../../src/app/middleware/cors";
import { parseCorsOriginsEnv } from "../../src/app/config/env.utils";
import { notFoundHandler } from "../../src/app/middleware/not-found";
import { errorHandler } from "../../src/app/middleware/error-handler";
import { validateRequest } from "../../src/app/middleware/validate-request";
import { AppError } from "../../src/app/shared/errors/app-error";

describe("rate-limit policy/parity (architecture)", () => {
  it("global limiter policy matches the legacy windowMs/max/message/header config exactly", () => {
    assert.equal(GLOBAL_LIMITER_POLICY.windowMs, 15 * 60 * 1000);
    assert.equal(GLOBAL_LIMITER_POLICY.max, 1000);
    assert.deepEqual(GLOBAL_LIMITER_POLICY.message, { message: "Too many requests. Please slow down." });
    assert.equal(GLOBAL_LIMITER_POLICY.standardHeaders, true);
    assert.equal(GLOBAL_LIMITER_POLICY.legacyHeaders, false);
  });

  it("auth limiter policy matches the legacy windowMs/max/message/header config exactly", () => {
    assert.equal(AUTH_LIMITER_POLICY.windowMs, 15 * 60 * 1000);
    assert.equal(AUTH_LIMITER_POLICY.max, 10);
    assert.deepEqual(AUTH_LIMITER_POLICY.message, { message: "Too many attempts. Please try again later." });
    assert.equal(AUTH_LIMITER_POLICY.standardHeaders, true);
    assert.equal(AUTH_LIMITER_POLICY.legacyHeaders, false);
  });

  it("a fresh auth limiter instance returns 429 with the exact message after exceeding max, with standard (not legacy) headers", async () => {
    // Uses its own factory-built instance/store -- never the shared
    // singleton mounted in app.ts -- so this can't leak state into or from
    // any other test in the suite.
    const app = express();
    app.use(createAuthRateLimiter());
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));

    for (let i = 0; i < AUTH_LIMITER_POLICY.max; i++) {
      const res = await request(app).get("/");
      assert.equal(res.status, 200, `request ${i + 1} should still be within the limit`);
    }

    const limited = await request(app).get("/");
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { message: "Too many attempts. Please try again later." });
    assert.ok(limited.headers["ratelimit-limit"] !== undefined, "standardHeaders should add a RateLimit-* header");
    assert.equal(limited.headers["x-ratelimit-limit"], undefined, "legacyHeaders is false -- no X-RateLimit-* header");
  });
});

describe("cors helpers (architecture)", () => {
  it("parseCorsOriginsEnv trims, drops empties, and collapses duplicates", () => {
    assert.deepEqual(
      parseCorsOriginsEnv(" https://a.example , https://b.example ,, https://a.example/ "),
      ["https://a.example", "https://b.example"]
    );
  });

  it("rejects a path, query, or hash", () => {
    assert.throws(() => parseCorsOriginsEnv("https://a.example/app"), /CORS_ORIGINS/);
    assert.throws(() => parseCorsOriginsEnv("https://a.example/?q=1"), /CORS_ORIGINS/);
    assert.throws(() => parseCorsOriginsEnv("https://a.example/#x"), /CORS_ORIGINS/);
  });

  it("middleware allows a configured origin, rejects another, and allows a missing Origin", async () => {
    const app = express();
    app.use(createCorsMiddleware(["https://a.example"]));
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err.message === CORS_REJECTION_MESSAGE) {
        res.status(403).json({ message: "Origin not allowed" });
        return;
      }
      res.status(500).json({ message: "unexpected" });
    });

    const allowed = await request(app).get("/").set("Origin", "https://a.example");
    assert.equal(allowed.status, 200);
    const rejected = await request(app).get("/").set("Origin", "https://evil.example");
    assert.equal(rejected.status, 403);
    const noOrigin = await request(app).get("/");
    assert.equal(noOrigin.status, 200);
  });
});

function buildErrorTestApp(throwErr: unknown): express.Express {
  const app = express();
  app.get("/", (_req, _res, next) => next(throwErr));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("error handler (architecture)", () => {
  it("keeps exactly 4 declared parameters so Express still recognizes it as error middleware", () => {
    assert.equal(errorHandler.length, 4);
    assert.notEqual(notFoundHandler.length, 4);
  });

  const cases: Array<[string, AppError, number]> = [
    ["badRequest", AppError.badRequest("bad"), 400],
    ["unauthorized", AppError.unauthorized("nope"), 401],
    ["forbidden", AppError.forbidden("no"), 403],
    ["notFound", AppError.notFound("missing"), 404],
    ["conflict", AppError.conflict("dupe"), 409],
  ];

  for (const [name, err, status] of cases) {
    it(`AppError.${name} produces status ${status} with body { message } only (no errorCode leak)`, async () => {
      const res = await request(buildErrorTestApp(err)).get("/");
      const body: Record<string, unknown> = res.body;
      assert.equal(res.status, status);
      assert.equal(body.message, err.message);
      assert.equal(body.errorCode, undefined);
      assert.deepEqual(Object.keys(body), ["message"]);
    });
  }

  it("an unexpected plain Error falls back to the existing generic 500 contract, leaking no internals", async () => {
    const res = await request(buildErrorTestApp(new Error("some sensitive internal detail"))).get("/");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "An unexpected error occurred. Please try again later." });
    assert.ok(!JSON.stringify(res.body).includes("some sensitive internal detail"));
  });

  it("the CORS-rejection error still gets the existing 403 contract", async () => {
    const res = await request(buildErrorTestApp(new Error(CORS_REJECTION_MESSAGE))).get("/");
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Origin not allowed" });
  });
});

describe("validateRequest (architecture)", () => {
  function buildValidateTestApp(schemas: Parameters<typeof validateRequest>[0]): express.Express {
    const app = express();
    app.use(express.json());
    app.get(
      "/:id",
      validateRequest(schemas),
      (req, res) => res.status(200).json({ params: req.params, query: req.query, body: req.body })
    );
    app.use(errorHandler);
    return app;
  }

  it("a valid body passes through unchanged", async () => {
    const app = buildValidateTestApp({ body: z.object({ name: z.string() }) });
    const res = await request(app).get("/1").send({ name: "ok" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.body, { name: "ok" });
  });

  it("an invalid body produces the stable 400 { message: \"Invalid request\" } contract, not raw Zod text", async () => {
    const app = buildValidateTestApp({ body: z.object({ name: z.string() }) });
    const res = await request(app).get("/1").send({ name: 123 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid request" });
  });

  it("valid params and query individually pass", async () => {
    const app = buildValidateTestApp({
      params: z.object({ id: z.string() }),
      query: z.object({ page: z.string() }),
    });
    const res = await request(app).get("/1?page=1");
    assert.equal(res.status, 200);
  });

  it("a coercion schema writes the coerced value back onto req.query", async () => {
    const app = buildValidateTestApp({ query: z.object({ page: z.coerce.number() }) });
    const res = await request(app).get("/1?page=2");
    assert.equal(res.status, 200);
    assert.strictEqual(res.body.query.page, 2);
  });

  it("checks params before body, so a failing params schema reports first even when body is also invalid", async () => {
    const app = buildValidateTestApp({
      params: z.object({ id: z.coerce.number() }),
      body: z.object({ name: z.string() }),
    });
    const res = await request(app).get("/not-a-number").send({ name: 123 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid request" });
  });
});
