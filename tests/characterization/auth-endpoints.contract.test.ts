// Characterizes routes/auth.routes.js's five HTTP endpoints end-to-end via
// supertest against the legacy app.js. Locks behavior before Stage 7's
// native TypeScript module replaces it in the TS candidate; production
// (index.js -> app.js) is unaffected either way.
//
// Deliberately does NOT reuse tests/helpers/create-test-app.ts's shared
// createTestApp(): routes/auth.routes.js (like every routes/*.routes.js file)
// creates its Express Router() ONCE at module load time, and its exported
// factory function keeps adding handlers to that SAME persistent router on
// every call instead of building a fresh one -- a real, pre-existing legacy
// quirk (not something Stage 7 may fix, since it's a protected file). Since
// Express runs handlers in registration order and these handlers never call
// next() on their own paths, only the FIRST test's closure (bound to the
// FIRST test's fake collection) would ever actually run for a given path
// across this whole process if the module cache were left alone -- silently
// serving every later test with the first test's stale data. freshApp()
// below busts the require cache for app.js + routes/auth.routes.js (and
// middleware/rateLimit.js, so each test also gets a brand-new, zero-count
// rate limiter instead of needing manual resets) before every call, so each
// test gets its own true single-registration router and its own fake data.
//
// Mandatory email-side-effect isolation (see the Stage 7 plan's ss11):
// successful /register and known-account /auth/forget-password both call the
// real emailSender()+waitUntil() (auth.routes.js:77-90,212-225). emailSender()
// itself guards on SMTP_HOST/EMAIL/APP_PASS being set and fails fast/safely
// (no network call) when they're absent -- so this file forcibly clears those
// three env vars before any test runs, REGARDLESS of whatever a local .env
// happens to contain, guaranteeing zero real SMTP and zero dependency on the
// developer's own environment. waitUntil() itself is a safe no-op outside a
// Vercel request context (confirmed by reading
// @vercel/functions/wait-until.js: it only forwards to an optional context
// callback), so no mocking of it is required once emailSender() is neutralized.
delete process.env.SMTP_HOST;
delete process.env.EMAIL;
delete process.env.APP_PASS;

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";

process.env.JWT_SECRET = "test-only-secret";
process.env.JWT_RESET_PASS_SECRET = "test-only-reset-secret";

function freshApp(usersCollection: unknown) {
  for (const mod of ["../../app", "../../routes/auth.routes", "../../middleware/rateLimit"]) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createApp = require("../../app");
  return createApp({
    usersCollection,
    coursesCollection: throwingCollection("coursesCollection"),
    schedulesCollection: throwingCollection("schedulesCollection"),
    bookingMockCollection: throwingCollection("bookingMockCollection"),
    client: {},
  });
}

async function hash(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

// Simulates the real registration race: both concurrent requests' pre-checks
// (findOne by email, findOne by transactionId) observe no conflict, but the
// unique {email} index still catches the write. FakeUsersCollection's own
// insertOne duplicate check is keyed off the same docs array findOne reads,
// so it can never reach this branch on its own -- this override decouples
// the two to actually exercise auth.routes.js's E11000 catch (see file header).
class RaceUsersCollection extends FakeUsersCollection {
  async insertOne(): Promise<never> {
    throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
  }
}

describe("POST /api/v1/register (characterization)", () => {
  it("missing email/password -> 400", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/register").send({ password: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Email and password are required" });
  });

  it("password < 8 chars -> 400", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/register").send({ email: "new@example.test", password: "short" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Password must be at least 8 characters" });
  });

  it("existing email -> 400 User already exists", async () => {
    const existing = { _id: new ObjectId(), email: "existing@example.test", password: "x" };
    const app = freshApp(new FakeUsersCollection([existing]));
    const res = await request(app)
      .post("/api/v1/register")
      .send({ email: "EXISTING@example.test", password: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "User already exists" });
  });

  it("existing transactionId -> 409", async () => {
    const existing = { _id: new ObjectId(), email: "other@example.test", password: "x", transactionId: "TXN-1" };
    const app = freshApp(new FakeUsersCollection([existing]));
    const res = await request(app)
      .post("/api/v1/register")
      .send({ email: "new@example.test", password: "longenough1", transactionId: "TXN-1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: "Transaction ID is already in use." });
  });

  it("concurrent duplicate insert (E11000) -> 409 User already exists", async () => {
    const app = freshApp(new RaceUsersCollection());
    const res = await request(app)
      .post("/api/v1/register")
      .send({ email: "race@example.test", password: "longenough1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: "User already exists" });
  });

  it("success -> 201 + userId, server-owned fields never trusted from body", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
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

describe("POST /api/v1/login (characterization)", () => {
  it("missing fields -> 400", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/login").send({ email: "a@b.test" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Email and password are required" });
  });

  it("unknown user -> 401 Invalid email or password", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/login").send({ email: "nobody@example.test", password: "whatever1" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Invalid email or password" });
  });

  it("wrong password -> 401 Invalid email or password", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: await hash("correct-password", 10), role: "user" };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/login").send({ email: "user@example.test", password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Invalid email or password" });
  });

  it("success -> 200 + accessToken/email/role/userId + cookie contract", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: await hash("correct-password", 10), role: "user" };
    const app = freshApp(new FakeUsersCollection([user]));
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
  });

  it("isDeleted=true account still receives a valid token on correct password -- login performs no account-state check (that happens at verifyToken on the NEXT request)", async () => {
    const user = {
      _id: new ObjectId(),
      email: "deleted@example.test",
      password: await hash("correct-password", 10),
      role: "user",
      isDeleted: true,
    };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/login").send({ email: "deleted@example.test", password: "correct-password" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.accessToken);
  });

  it("status=\"blocked\" account still receives a valid token on correct password -- same reason as isDeleted above", async () => {
    const user = {
      _id: new ObjectId(),
      email: "blocked@example.test",
      password: await hash("correct-password", 10),
      role: "user",
      status: "blocked",
    };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/login").send({ email: "blocked@example.test", password: "correct-password" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

describe("POST /api/v1/auth/forget-password (characterization)", () => {
  it("missing email -> 400", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/auth/forget-password").send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Email is required" });
  });

  it("unknown account -> 200 identical generic body (anti-enumeration)", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).post("/api/v1/auth/forget-password").send({ email: "nobody@example.test" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Password reset link sent successfully" });
  });

  it("known account -> 200 the SAME generic body", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: "x", name: "A User" };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app).post("/api/v1/auth/forget-password").send({ email: "user@example.test" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Password reset link sent successfully" });
  });
});

describe("PUT /api/v1/auth/reset-password (characterization)", () => {
  function resetToken(userId: ObjectId, overrides: Record<string, unknown> = {}): string {
    return jwt.sign(
      { email: "user@example.test", userId: userId.toString(), ...overrides },
      process.env.JWT_RESET_PASS_SECRET as string,
      { expiresIn: "15m" }
    );
  }

  it("missing fields -> 400 All fields are required", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app).put("/api/v1/auth/reset-password").send({ userId: "x" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "All fields are required" });
  });

  it("invalid ObjectId -> 400 Invalid user ID", async () => {
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: "not-an-object-id", token: "t", newPassword: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid user ID" });
  });

  it("password < 8 chars -> 400", async () => {
    const userId = new ObjectId();
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token: "t", newPassword: "short" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Password must be at least 8 characters" });
  });

  it("invalid/expired token -> 400 Invalid or expired token!", async () => {
    const userId = new ObjectId();
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token: "not-a-real-jwt", newPassword: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid or expired token!" });
  });

  it("token/body userId mismatch -> 400 Token mismatch!", async () => {
    const tokenUserId = new ObjectId();
    const bodyUserId = new ObjectId();
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: bodyUserId.toString(), token: resetToken(tokenUserId), newPassword: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Token mismatch!" });
  });

  it("user not found -> 404", async () => {
    const userId = new ObjectId();
    const app = freshApp(new FakeUsersCollection());
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token: resetToken(userId), newPassword: "longenough1" });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: "User not found or inactive!" });
  });

  it("token predates passwordChangedAt -> 400 already been used", async () => {
    const userId = new ObjectId();
    const user = {
      _id: userId,
      email: "user@example.test",
      password: "x",
      passwordChangedAt: new Date(Date.now() + 60_000),
    };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token: resetToken(userId), newPassword: "longenough1" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "This reset link has already been used." });
  });

  it("success -> 200", async () => {
    const userId = new ObjectId();
    const user = { _id: userId, email: "user@example.test", password: "old-hash" };
    const collection = new FakeUsersCollection([user]);
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/auth/reset-password")
      .send({ userId: userId.toString(), token: resetToken(userId), newPassword: "longenough1" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Password reset successfully" });
    assert.notEqual(collection.find()[0].password, "old-hash");
  });
});

describe("PUT /api/v1/user/change-password (characterization)", () => {
  // verifyToken's checkAccountState runs BEFORE this route's own body logic
  // and requires the token's userId to resolve to a real, non-blocked
  // account -- so every scenario below needs a real account-state document,
  // distinct from whatever "target" user (if any) the test's email-based
  // lookup inside the handler itself is exercising.
  function signToken(userId: ObjectId, email: string | undefined): string {
    const payload: Record<string, unknown> = { userId: userId.toString(), role: "user" };
    if (email !== undefined) payload.email = email;
    return jwt.sign(payload, process.env.JWT_SECRET as string);
  }

  function freshActorToken(collection: FakeUsersCollection, email: string | undefined): string {
    const userId = new ObjectId();
    collection.addDoc({
      _id: userId,
      email: "actor-account-state@example.test",
      password: "irrelevant-for-verifyToken",
      isDeleted: false,
      status: "active",
      role: "user",
    });
    return signToken(userId, email);
  }

  it("missing fields -> 400", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${freshActorToken(collection, "user@example.test")}`)
      .send({ email: "user@example.test" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Email, oldPassword, newPassword are required" });
  });

  it("body email != verified token email -> 403 Forbidden", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${freshActorToken(collection, "actor@example.test")}`)
      .send({ email: "someone-else@example.test", oldPassword: "old12345", newPassword: "new12345" });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden" });
  });

  it("a valid signed JWT missing the email claim -> 500 Server error (observed legacy behavior, not hardened during migration)", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${freshActorToken(collection, undefined)}`)
      .send({ email: "user@example.test", oldPassword: "old12345", newPassword: "new12345" });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "Server error" });
  });

  it("new password < 8 chars -> 400", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${freshActorToken(collection, "user@example.test")}`)
      .send({ email: "user@example.test", oldPassword: "old12345", newPassword: "short" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "New password must be at least 8 characters" });
  });

  it("user not found -> 404", async () => {
    const collection = new FakeUsersCollection();
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${freshActorToken(collection, "ghost@example.test")}`)
      .send({ email: "ghost@example.test", oldPassword: "old12345", newPassword: "new12345" });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: "User not found" });
  });

  it("wrong old password -> 401 Password incorrect", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: await hash("correct-old", 12), role: "user", isDeleted: false, status: "active" };
    const collection = new FakeUsersCollection([user]);
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${signToken(user._id, user.email)}`)
      .send({ email: "user@example.test", oldPassword: "wrong-old", newPassword: "new12345" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Password incorrect" });
  });

  it("success -> 200, needPasswordChange=false, passwordChangedAt set", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: await hash("correct-old", 12), role: "user", isDeleted: false, status: "active" };
    const collection = new FakeUsersCollection([user]);
    const app = freshApp(collection);
    const res = await request(app)
      .put("/api/v1/user/change-password")
      .set("Authorization", `Bearer ${signToken(user._id, user.email)}`)
      .send({ email: "user@example.test", oldPassword: "correct-old", newPassword: "new12345" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { message: "Password changed successfully!" });
    const stored = collection.find()[0];
    assert.equal(stored.needPasswordChange, false);
    assert.ok(stored.passwordChangedAt instanceof Date);
  });
});
