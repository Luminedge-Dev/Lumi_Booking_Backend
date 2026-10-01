// Proves src/app.ts (now an independent composition root, not a delegator) is
// behaviorally identical to the legacy app.js contract already locked in
// tests/characterization/app.contract.test.ts. Reuses the same throwingCollection
// fake (no real DB access) but goes through the new TypeScript boundary.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import { throwingCollection } from "../helpers/create-test-app";
import { legacyAuthLimiter, legacyGlobalLimiter } from "../../src/app/compat/legacy-middleware";

type TestApp = (req: IncomingMessage, res: ServerResponse) => unknown;

function fakeDependencies(): AppDependencies {
  // throwingCollection returns a Proxy standing in for a Collection, not a real
  // driver instance — the cast is the test fixture's own documented boundary,
  // same as the legacy characterization helper it wraps.
  return {
    usersCollection: throwingCollection("usersCollection") as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
}

function createTsTestApp(): TestApp {
  // No corsOrigins override -> exercises the same DEFAULT_ORIGINS fallback the
  // legacy contract test relies on.
  return createApp(fakeDependencies()) as unknown as TestApp;
}

describe("src/app.ts boundary (architecture parity)", () => {
  it("GET / returns the running contract with a parseable timestamp", async () => {
    const res = await request(createTsTestApp()).get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] as string, /application\/json/);
    assert.equal(res.body.message, "Server is running smoothly");
    assert.ok(res.body.timestamp, "timestamp exists");
    assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)), "timestamp is parseable");
  });

  it("unknown route returns the JSON 404 contract", async () => {
    const res = await request(createTsTestApp()).get("/definitely-not-a-real-route");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: "Not found" });
  });

  it("allows a known browser origin", async () => {
    const res = await request(createTsTestApp())
      .get("/")
      .set("Origin", "http://localhost:3000");
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
  });

  it("rejects an unknown origin with the 403 contract", async () => {
    const res = await request(createTsTestApp())
      .get("/")
      .set("Origin", "https://evil.example");
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Origin not allowed" });
  });

  it("sends baseline security headers and hides powered-by", async () => {
    const res = await request(createTsTestApp()).get("/");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-powered-by"], undefined);
  });

  it("trust proxy is enabled for correct req.ip / secure-cookie detection behind Vercel", () => {
    const app = createApp(fakeDependencies());
    assert.equal(app.get("trust proxy"), 1);
  });

  it("global limiter is wired before routes and auth limiter targets the auth-only paths", () => {
    const app = createApp(fakeDependencies());
    const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown; route?: unknown; regexp: RegExp }> } })
      ._router.stack;

    const globalIdx = stack.findIndex((layer) => layer.handle === legacyGlobalLimiter);
    const firstRouteIdx = stack.findIndex((layer) => layer.route !== undefined);
    assert.ok(globalIdx !== -1, "global limiter layer should be present");
    assert.ok(firstRouteIdx !== -1, "at least one route layer should be present");
    assert.ok(globalIdx < firstRouteIdx, "global limiter should be mounted before any route");

    const authLimiterLayer = stack.find((layer) => layer.handle === legacyAuthLimiter);
    assert.ok(authLimiterLayer, "auth limiter layer should be present");
    for (const p of ["/api/v1/login", "/api/v1/register", "/api/v1/auth/forget-password", "/api/v1/auth/reset-password"]) {
      assert.ok(authLimiterLayer!.regexp.test(p), `auth limiter should match ${p}`);
    }
  });
});
