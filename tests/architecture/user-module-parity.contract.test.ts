// Proves the native TypeScript User module (src/app/modules/user, mounted by
// src/app.ts) matches the legacy contract locked in
// tests/characterization/user-reads.contract.test.ts for every PRESERVED
// case, and intentionally diverges (200 -> 403) for every case Stage 8
// deliberately closes. Also proves the mandatory route-collision guard:
// native GET /user/:userId must never shadow legacy GET /user/all.
//
// Unlike the legacy characterization helper, src/app/modules/user/user.route.ts
// calls Router() fresh inside createUserRouter() every time (not at module
// top level), so no require-cache-busting is needed here (same as Stage 7's
// native parity pattern).
import { afterEach, describe, it } from "node:test";
import { fakeCoreRepositories } from "../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../helpers/fake-users-repositories";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import { authRateLimiter as authRateLimiterHandler } from "../../src/app/middleware/rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";

// Unlike Stage 7's auth-module-parity file, this one deliberately exercises
// FALLTHROUGH to the still-mounted legacy userRoutes() router (/user/all,
// /admin/users), which is guarded by middleware/auth.js's verifyAdmin --
// that reads process.env.JWT_SECRET directly, independent of the native
// module's fakeAuthConfig(). Both must agree or legacy's verifyAdmin fails
// signature verification against a token actually signed for the native
// module.
process.env.JWT_SECRET = "test-only-secret";

const authRateLimiter = authRateLimiterHandler as unknown as RateLimitRequestHandler;

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

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

describe("native User module parity: GET /api/v1/user/status/:userId", () => {
  it("self -> 200, identical to legacy", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/status/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "self@example.test");
  });

  it("admin/bdm/teacher targeting another user -> 200 (preserved)", async () => {
    for (const role of ["admin", "bdm", "teacher"]) {
      const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role };
      const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
      const app = appWith(new FakeUsersCollection([actor, other]));
      const res = await request(app)
        .get(`/api/v1/user/status/${other._id}`)
        .set("Authorization", `Bearer ${signToken(actor._id, role)}`);
      assert.equal(res.status, 200, `expected ${role} to access another user's status`);
    }
  });

  it("INTENTIONAL CHANGE: normal user targeting another user -> 403 (was 200 in legacy)", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([actor, other]));
    const res = await request(app)
      .get(`/api/v1/user/status/${other._id}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden" });
  });

  it("missing user (valid ObjectId) -> 200 {user:null}, preserved exactly (staff access to a non-existent target)", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const app = appWith(new FakeUsersCollection([admin]));
    const res = await request(app)
      .get(`/api/v1/user/status/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { user: null });
  });

  it("invalid ObjectId -> 400, identical body to legacy", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app)
      .get("/api/v1/user/status/not-a-valid-id")
      .set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid user ID format." });
  });

  it("EXPECTED INTENTIONAL (Stage 15): modeled columns pass through; unmodeled legacy keys (dateofbirth spelling, unknown fields) are not carried by PostgreSQL; password never present", async () => {
    const self = {
      _id: new ObjectId(),
      email: "self@example.test",
      password: "secret-hash",
      role: "user",
      dateOfBirth: "1990-01-01",
      dateofbirth: "1990-01-01",
      someUnexpectedLegacyField: "legacy-value",
    };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/status/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.dateOfBirth, "1990-01-01");
    assert.equal(res.body.user.dateofbirth, undefined);
    assert.equal(res.body.user.someUnexpectedLegacyField, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.user, "password"));
  });

  it("no token -> 401 NO_TOKEN (never a misleading 403)", async () => {
    const app = appWith(new FakeUsersCollection());
    const res = await request(app).get(`/api/v1/user/status/${new ObjectId()}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Unauthorized", code: "NO_TOKEN" });
  });
});

describe("native User module parity: GET /api/v1/profile/:userId", () => {
  it("self -> 200 with phone/passportId aliases", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user", contactNo: "0123456789", passportNumber: "P12345" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/profile/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.phone, "0123456789");
    assert.equal(res.body.user.passportId, "P12345");
  });

  it("INTENTIONAL CHANGE: admin targeting another user -> 403 (self-only even for staff, was 200 in legacy)", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([admin, other]));
    const res = await request(app)
      .get(`/api/v1/profile/${other._id}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 403);
  });

  // No HTTP-level "missing user -> 404" test here: /profile is self-only, and
  // Stage 7's verifyToken already requires the authenticated actor to exist
  // (checkAccountState -> ACCOUNT_NOT_FOUND -> 401) before this route's own
  // authorization/controller ever runs. Since the target is always the same
  // already-verified-existing actor, the controller's 404 branch is
  // unreachable through a real authenticated request -- it's proven correct
  // in isolation instead, by tests/modules/user/user.service.test.ts's
  // "UserService.getProfile: returns null for a missing user".

  it("invalid ObjectId -> 400, identical to legacy", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app)
      .get("/api/v1/profile/not-a-valid-id")
      .set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid user ID" });
  });
});

describe("native User module parity: POST /api/v1/user/request-profile-edit", () => {
  it("SECURITY FIX: actor A's token + body.userId=B -> 403, AND B's document is NOT modified", async () => {
    const actorA = { _id: new ObjectId(), email: "a@example.test", password: "x", role: "user" };
    const userB = { _id: new ObjectId(), email: "b@example.test", password: "x", role: "user", profileChangeRequestStatus: "default" };
    const collection = new FakeUsersCollection([actorA, userB]);
    const app = appWith(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(actorA._id)}`)
      .send({ userId: userB._id.toString(), note: "attempted cross-user edit" });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden" });
    // The critical proof: B's document was never touched -- authorization
    // ran before any repository write.
    const stored = collection.find().find((d) => d._id.equals(userB._id));
    assert.equal(stored?.profileChangeRequestStatus, "default");
    assert.equal(stored?.profileEditNote, undefined);
  });

  it("self -> 200, identical success body to legacy", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ userId: self._id.toString(), note: "please update" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Profile change request submitted" });
  });

  it("missing/invalid userId -> 400, identical to legacy, reached BEFORE authorization", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ note: "no userId" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid or missing userId" });
  });

  it("EXPECTED INTENTIONAL (Stage 15): non-text note is rejected 400 (PostgreSQL column is text); legacy persisted any truthy value", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const collection = new FakeUsersCollection([self]);
    const app = appWith(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ userId: self._id.toString(), note: 123 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid note" });
    const stored = collection.find().find((d) => d._id.equals(self._id));
    assert.strictEqual(stored?.profileEditNote, undefined);
  });

  it("PARITY: falsy note (null) maps to empty string, exactly like legacy note || ''", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const collection = new FakeUsersCollection([self]);
    const app = appWith(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ userId: self._id.toString(), note: null });
    assert.equal(res.status, 200);
    const stored = collection.find().find((d) => d._id.equals(self._id));
    assert.strictEqual(stored?.profileEditNote, "");
  });
});

describe("native User module parity: GET /api/v1/users/with-profile-request", () => {
  it("admin -> 200, identical projection to legacy", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const requester = {
      _id: new ObjectId(),
      email: "requester@example.test",
      password: "x",
      role: "user",
      profileChangeRequestStatus: "requested",
    };
    const app = appWith(new FakeUsersCollection([admin, requester]));
    const res = await request(app)
      .get("/api/v1/users/with-profile-request")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 1);
  });

  it("bdm/teacher/normal user -> 403, PRESERVED (not a new Stage 8 behavior)", async () => {
    for (const role of ["bdm", "teacher", "user"]) {
      const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role };
      const app = appWith(new FakeUsersCollection([actor]));
      const res = await request(app)
        .get("/api/v1/users/with-profile-request")
        .set("Authorization", `Bearer ${signToken(actor._id, role)}`);
      assert.equal(res.status, 403, `expected ${role} to be denied`);
    }
  });
});

describe("native User module parity: GET /api/v1/user/:userId", () => {
  it("self -> 200 with fallback chain, identical to legacy", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user", mocks: [{ transactionId: "TXN-NEW" }] };
    const app = appWith(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.transactionId, "TXN-NEW");
  });

  it("admin/bdm/teacher targeting another user -> 200 (preserved)", async () => {
    for (const role of ["admin", "bdm", "teacher"]) {
      const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role };
      const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
      const app = appWith(new FakeUsersCollection([actor, other]));
      const res = await request(app).get(`/api/v1/user/${other._id}`).set("Authorization", `Bearer ${signToken(actor._id, role)}`);
      assert.equal(res.status, 200, `expected ${role} to access another user's summary`);
    }
  });

  it("INTENTIONAL CHANGE: normal user targeting another user -> 403 (was 200 in legacy)", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([actor, other]));
    const res = await request(app).get(`/api/v1/user/${other._id}`).set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 403);
  });

  it("missing user -> 404, identical to legacy (staff access to a non-existent target)", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const app = appWith(new FakeUsersCollection([admin]));
    const res = await request(app)
      .get(`/api/v1/user/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 404);
  });

  it("MANDATORY ROUTE-COLLISION GATE: GET /user/all falls through to legacy, is NOT shadowed by native /user/:userId", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const app = appWith(new FakeUsersCollection([admin]));
    const res = await request(app).get("/api/v1/user/all").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), "expected legacy GET /user/all's array response, not a native 400/403");
  });

  it("GET /user/all with a non-admin token -> 403 from the legacy handler (fell through correctly, not denied natively)", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: "x", role: "user" };
    const app = appWith(new FakeUsersCollection([user]));
    const res = await request(app).get("/api/v1/user/all").set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  });

  // No GET /admin/users test here: it's a completely separate literal path
  // (registered on the legacy router, same as /user/all) with zero overlap
  // or collision risk with native /user/:userId's pattern -- the /user/all
  // test above already proves the fallthrough mechanism works, and
  // /admin/users's own sort/skip/limit/maxTimeMS cursor usage is unrelated
  // legacy pagination logic this stage never touches.
});
