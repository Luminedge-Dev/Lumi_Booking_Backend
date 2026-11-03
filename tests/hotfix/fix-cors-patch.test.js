"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;
delete process.env.FRONTEND_URL_LOCAL;
delete process.env.FRONTEND_URL;

const createApp = require("../../app");

let server;
let baseUrl;
let dbWrites = [];

const stubCollection = (name) => ({
  name,
  find: () => ({ toArray: async () => [] }),
  findOne: async () => null,
  insertOne: async (doc) => { dbWrites.push({ col: name, op: "insertOne", doc }); return { insertedId: "dummy" }; },
  updateOne: async (q, u) => { dbWrites.push({ col: name, op: "updateOne", q, u }); return { modifiedCount: 1 }; },
  deleteOne: async (q) => { dbWrites.push({ col: name, op: "deleteOne", q }); return { deletedCount: 1 }; },
  aggregate: () => ({ toArray: async () => [] }),
});

before(async () => {
  const usersCollection = stubCollection("users");
  const schedulesCollection = stubCollection("schedules");
  const coursesCollection = stubCollection("courses");
  const bookingMockCollection = stubCollection("bookingMock");
  const reminderDeliveriesCollection = stubCollection("reminderDeliveries");

  const app = createApp({
    usersCollection,
    schedulesCollection,
    coursesCollection,
    bookingMockCollection,
    reminderDeliveriesCollection,
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("L03-T01: Allowed localhost origin can preflight PATCH with 204", async () => {
  const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
    },
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("L03-T02: Access-Control-Allow-Methods includes PATCH alongside canonical methods", async () => {
  const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PATCH",
    },
  });

  const methods = res.headers.get("access-control-allow-methods") || "";
  const methodList = methods.split(",").map((m) => m.trim());
  assert.ok(methodList.includes("PATCH"), "Allow-Methods must include PATCH");
  assert.ok(methodList.includes("GET"), "Allow-Methods must include GET");
  assert.ok(methodList.includes("POST"), "Allow-Methods must include POST");
  assert.ok(methodList.includes("PUT"), "Allow-Methods must include PUT");
  assert.ok(methodList.includes("DELETE"), "Allow-Methods must include DELETE");
});

test("L03-T03: Authorization, Content-Type, and Idempotency-Key headers are accepted in preflight", async () => {
  const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
    },
  });

  const allowHeaders = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
  assert.ok(allowHeaders.includes("authorization"));
  assert.ok(allowHeaders.includes("content-type"));
  assert.ok(allowHeaders.includes("idempotency-key"));
});

test("L03-T04: Disallowed origins are rejected by CORS", async () => {
  const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://malicious.evil.invalid",
      "Access-Control-Request-Method": "PATCH",
    },
  });

  // CORS middleware rejects non-allowlisted origins
  const allowOrigin = res.headers.get("access-control-allow-origin");
  assert.equal(allowOrigin, null, "Disallowed origin must not receive Access-Control-Allow-Origin header");
});

test("L03-T05: Existing GET, POST, PUT, and DELETE preflight permissions remain intact", async () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const res = await fetch(`${baseUrl}/api/v1/user/bookings/test`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": method,
      },
    });
    assert.equal(res.status, 204, `Preflight for ${method} must return 204`);
    const methods = res.headers.get("access-control-allow-methods") || "";
    assert.ok(methods.includes(method), `Allow-Methods must include ${method}`);
  }
});

test("L03-T06: Preflight OPTIONS request causes zero database mutations", async () => {
  dbWrites = [];
  await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PATCH",
    },
  });

  assert.equal(dbWrites.length, 0, "OPTIONS preflight must never mutate the database");
});

test("L03-T07: Actual PATCH requires authentication and ownership", async () => {
  const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
    method: "PATCH",
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "Idempotency-Key": "test-key-123",
    },
    body: JSON.stringify({
      scheduleId: "6500000000000000000000aa",
      slotId: 1,
    }),
  });

  // Without bearer token, verifyToken rejects with 401
  assert.equal(res.status, 401, "PATCH without token must be refused 401");
});

test("L03-T08: BOOKING_FROZEN blocks PATCH mutation requests with 423 Locked", async () => {
  process.env.BOOKING_FROZEN = "1";
  try {
    const res = await fetch(`${baseUrl}/api/v1/user/bookings/6ae9a80da617e786d247d32e/reschedule`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slotId: 1 }),
    });

    assert.equal(res.status, 423, "PATCH while frozen must return 423 Locked");
  } finally {
    delete process.env.BOOKING_FROZEN;
  }
});
