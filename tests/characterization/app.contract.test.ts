// Characterization of the current app.js external contract.
// Locks behavior only; any failure here means the contract drifted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp } from "../helpers/create-test-app";

describe("app external contract (characterization)", () => {
  it("GET / returns the running contract with a parseable timestamp", async () => {
    const res = await request(createTestApp()).get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] as string, /application\/json/);
    assert.equal(res.body.message, "Server is running smoothly");
    assert.ok(res.body.timestamp, "timestamp exists");
    assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)), "timestamp is parseable");
  });

  it("unknown route returns the JSON 404 contract", async () => {
    const res = await request(createTestApp()).get("/definitely-not-a-real-route");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: "Not found" });
  });

  it("allows a known browser origin", async () => {
    const res = await request(createTestApp())
      .get("/")
      .set("Origin", "http://localhost:3000");
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
  });

  it("rejects an unknown origin with the 403 contract", async () => {
    const res = await request(createTestApp())
      .get("/")
      .set("Origin", "https://evil.example");
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Origin not allowed" });
  });

  it("allows a request with no Origin header (non-browser/server-to-server clients)", async () => {
    const res = await request(createTestApp()).get("/");
    assert.equal(res.status, 200);
  });

  it("sends baseline security headers and hides powered-by", async () => {
    const res = await request(createTestApp()).get("/");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-powered-by"], undefined);
  });
});
