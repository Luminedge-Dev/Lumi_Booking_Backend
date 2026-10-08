// Proves the native TypeScript Auth module (src/app/modules/auth, mounted by
// src/app.ts) exposes the exact same public status/body/cookie contract that
// tests/characterization/auth-endpoints.contract.test.ts and
// auth-middleware-extended.contract.test.ts already locked against the
// legacy routes/auth.routes.js + middleware/auth.js. This is the "candidate
// exposes the exact same public Auth surface" parity check the Stage 7 plan
// calls for.
//
// Unlike the legacy characterization helper, src/app/modules/auth/auth.route.ts
// calls Router() fresh inside createAuthRouter() every time (not at module
// top level), so src/app.ts's createApp() does NOT have the legacy
// module-singleton-router accumulation bug -- no require-cache-busting is
// needed here, same pattern tests/architecture/app-boundary.contract.test.ts
// already uses.
//
// Mandatory email isolation (same reasoning as the characterization file):
// successful register/forgot-password go through legacyEmailSender, which
// calls the real emailSender() -- neutralized by clearing SMTP env vars so
// no real network call is ever attempted, regardless of the developer's .env.
delete process.env.SMTP_HOST;
delete process.env.EMAIL;
delete process.env.APP_PASS;

import { afterEach, describe, it } from "node:test";
import { fakeCoreRepositories } from "../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../helpers/fake-users-repositories";
import assert from "node:assert/strict";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import { authRateLimiter as authRateLimiterHandler } from "../../src/app/middleware/rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";

// rate-limit.ts exports authRateLimiter typed as the plain Express
// RequestHandler it's assigned to (so app.ts's app.use() call doesn't need to
// know about express-rate-limit's richer type) -- this cast recovers the
// resetKey/getKey members that the real underlying object actually has, for
// test-only cleanup.
const authRateLimiter = authRateLimiterHandler as unknown as RateLimitRequestHandler;
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";

function fakeAuthConfig(): AuthConfig {
  return {
    jwtSecret: "test-only-secret",
    jwtResetPasswordSecret: "test-only-reset-secret",
    jwtExpiresIn: "7d",
    jwtResetPasswordTokenExpiresIn: "15m",
    resetPasswordLink: "https://example.test/reset-password",
    isProduction: false,
  };
}

// authRateLimiter is a module-level singleton shared across every createApp()
// call in this process (src/app.ts imports the production singleton, not the
// per-test factory) -- reset between tests for the same reason as the legacy
// characterization file.
afterEach(async () => {
  await authRateLimiter.resetKey("::ffff:127.0.0.1");
  await authRateLimiter.resetKey("127.0.0.1");
});

function appWith(usersCollection: FakeUsersCollection) {
  const dependencies: AppDependencies = {
    usersCollection: usersCollection as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, { corsOrigins: ["http://localhost:3000"], trustProxyHops: 1, authConfig: fakeAuthConfig(), repositories: fakeCoreRepositories(usersBackedRepositories(usersCollection)) });
}

async function hash(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

// Same race-simulation override as
// tests/characterization/auth-endpoints.contract.test.ts's RaceUsersCollection
// -- decouples the pre-check (findOne, which still returns null) from the
// write-time unique-index failure, proving native parity with that same case.
class RaceUsersCollection extends FakeUsersCollection {
  async insertOne(): Promise<never> {
    throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
  }
}

describe("native Auth module parity: POST /api/v1/register", () => {
  it("missing email/password -> 400 (same body as legacy)", async () => {
    const app = appWith(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/register").send({ password: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Email and password are required" });
  });

  it("existing email -> 400 User already exists", async () => {
    const existing = { _id: new ObjectId(), email: "existing@example.test", password: "x" };
    const app = appWith(new FakeUsersCollection([existing]));
    const res = await request(app).post("/api/v1/register").send({ email: "EXISTING@example.test", password: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "User already exists" });
  });

  it("existing transactionId -> 409", async () => {
    const existing = { _id: new ObjectId(), email: "other@example.test", password: "x", transactionId: "TXN-1" };
    const app = appWith(new FakeUsersCollection([existing]));
    const res = await request(app)
      .post("/api/v1/register")
      .send({ email: "new@example.test", password: "longenough1", transactionId: "TXN-1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: "Transaction ID is already in use." });
  });

  it("concurrent duplicate insert (E11000) -> 409 User already exists (parity with legacy)", async () => {
    const app = appWith(new RaceUsersCollection());
    const res = await request(app)
      .post("/api/v1/register")
      .send({ email: "race@example.test", password: "longenough1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: "User already exists" });
  });

  it("success -> 201 + userId, server-owned fields never trusted from body", async () => {
    const collection = new FakeUsersCollection();
    const app = appWith(collection);
    const res = await request(app).post("/api/v1/register").send({
      email: "new@example.test",
      password: "longenough1",
      role: "admin",
      status: "completed",
      isDeleted: true,
      mock: 999,
      totalMock: 999,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, "User registered successfully");
    assert.ok(res.body.userId);

    const stored = collection.find()[0];
    assert.equal(stored.role, "user");
    assert.equal(stored.status, "active");
    assert.equal(stored.isDeleted, false);
    assert.equal(stored.mock, 0);
    assert.equal(stored.totalMock, 0);
  });
});

describe("native Auth module parity: POST /api/v1/login", () => {
  it("unknown user -> 401 Invalid email or password", async () => {
    const app = appWith(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/login").send({ email: "nobody@example.test", password: "whatever1" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Invalid email or password" });
  });

  it("success -> 200 + accessToken/email/role/userId + HttpOnly cookie", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: await hash("correct-password", 10), role: "user" };
    const app = appWith(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/login").send({ email: "user@example.test", password: "correct-password" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.accessToken);
    assert.equal(res.body.email, "user@example.test");
    assert.equal(res.body.role, "user");
    assert.equal(res.body.userId, user._id.toString());

    const setCookie = res.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /^token=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const decoded = jwt.decode(res.body.accessToken) as Record<string, unknown>;
    assert.equal(decoded.email, "user@example.test");
    assert.equal(decoded.userId, user._id.toString());
    assert.equal(decoded.role, "user");
  });

  it("isDeleted=true account still receives a valid token on correct password (parity with legacy's no-account-state-check-at-login behavior)", async () => {
    const user = {
      _id: new ObjectId(),
      email: "deleted@example.test",
      password: await hash("correct-password", 10),
      role: "user",
      isDeleted: true,
    };
    const app = appWith(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/login").send({ email: "deleted@example.test", password: "correct-password" });
    assert.equal(res.status, 200);
  });
});

describe("native Auth module parity: verifyToken-protected route (change-password) and the native middleware", () => {
  it("no token -> 401 NO_TOKEN (same code as legacy verifyToken)", async () => {
    const app = appWith(new FakeUsersCollection());
    const res = await request(app).put("/api/v1/user/change-password").send({});
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Unauthorized", code: "NO_TOKEN" });
  });

  it("valid token, deleted account -> 401 ACCOUNT_BLOCKED (native checkAccountState parity)", async () => {
    const userId = new ObjectId();
    const collection = new FakeUsersCollection([
      { _id: userId, email: "x@example.test", password: "x", isDeleted: true, status: "active", role: "user" },
    ]);
    const app = appWith(collection);
    const token = jwt.sign({ userId: userId.toString(), email: "x@example.test", role: "user" }, "test-only-secret");
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "x@example.test", oldPassword: "a", newPassword: "b" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Session no longer valid", code: "ACCOUNT_BLOCKED" });
  });

  it("success -> 200, needPasswordChange=false, passwordChangedAt set", async () => {
    const user = {
      _id: new ObjectId(),
      email: "user@example.test",
      password: await hash("correct-old", 12),
      role: "user",
      isDeleted: false,
      status: "active",
    };
    const collection = new FakeUsersCollection([user]);
    const app = appWith(collection);
    const token = jwt.sign({ userId: user._id.toString(), email: user.email, role: "user" }, "test-only-secret");
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "user@example.test", oldPassword: "correct-old", newPassword: "new12345" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { message: "Password changed successfully!" });
    const stored = collection.find()[0];
    assert.equal(stored.needPasswordChange, false);
    assert.ok(stored.passwordChangedAt instanceof Date);
  });
});

describe("native Auth module parity: POST /api/v1/auth/forget-password", () => {
  it("unknown and known accounts get the identical generic 200 body (anti-enumeration)", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: "x", name: "A User" };
    const app = appWith(new FakeUsersCollection([user]));

    const unknown = await request(app).post("/api/v1/auth/forget-password").send({ email: "nobody@example.test" });
    const known = await request(app).post("/api/v1/auth/forget-password").send({ email: "user@example.test" });

    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.body, known.body);
    assert.deepEqual(known.body, { success: true, message: "Password reset link sent successfully" });
  });
});

describe("native Auth module parity: PUT /api/v1/auth/reset-password", () => {
  it("success -> 200, password actually updated", async () => {
    const userId = new ObjectId();
    const user = { _id: userId, email: "user@example.test", password: "old-hash" };
    const collection = new FakeUsersCollection([user]);
    const app = appWith(collection);
    const token = jwt.sign({ email: user.email, userId: userId.toString() }, "test-only-reset-secret", { expiresIn: "15m" });
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token, newPassword: "longenough1" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Password reset successfully" });
    assert.notEqual(collection.find()[0].password, "old-hash");
  });
});

describe("native Auth module parity: scripts/mint-service-token.js compatibility", () => {
  it("a long-lived {email,userId,role} service token is still accepted on a verifyToken-protected route", async () => {
    const userId = new ObjectId();
    const collection = new FakeUsersCollection([
      { _id: userId, email: "service@luminedge.test", password: await hash("correct-old", 12), isDeleted: false, status: "active", role: "admin" },
    ]);
    const app = appWith(collection);
    const serviceToken = jwt.sign(
      { email: "service@luminedge.test", userId: userId.toString(), role: "admin" },
      "test-only-secret",
      { expiresIn: "365d" }
    );
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${serviceToken}`)
      .send({ email: "service@luminedge.test", oldPassword: "correct-old", newPassword: "new12345" });
    assert.equal(res.status, 200);
  });
});
