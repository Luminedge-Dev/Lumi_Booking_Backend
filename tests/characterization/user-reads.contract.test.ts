// Characterizes routes/user.routes.js's 5 read/profile-edit endpoints
// end-to-end via supertest against the legacy app.js, BEFORE Stage 8's
// native TypeScript module replaces them in the TS candidate. Production
// (index.js -> app.js) is unaffected either way.
//
// Deliberately does NOT reuse the shared createTestApp(): routes/user.routes.js
// (like every routes/*.routes.js file, confirmed by reading it) creates its
// Express Router() ONCE at module load time and keeps adding handlers to
// that SAME persistent router on every factory call -- the exact
// Router()-singleton bug Stage 7 found in auth.routes.js. freshApp() below
// busts the require cache for app.js + routes/user.routes.js before every
// call, so each test gets its own true single-registration router and its
// own fake data.
//
// Deliberately documents, not preserves, three current cross-user security
// gaps this file characterizes as pre-fix behavior (see
// context/migration-inventory.md's CONFIRMED SECURITY GAP entries) --
// Stage 8's native module intentionally closes these; this file exists to
// prove exactly what is being closed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";

process.env.JWT_SECRET = "test-only-secret";

function freshApp(usersCollection: unknown) {
  for (const mod of ["../../app", "../../routes/user.routes"]) {
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

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

describe("GET /api/v1/user/status/:userId (characterization)", () => {
  it("self -> 200 {user}", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/status/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "self@example.test");
    assert.equal(res.body.user.password, undefined);
  });

  it("CURRENTLY cross-user (normal actor targeting another user) -> 200, pre-fix behavior being intentionally closed by Stage 8", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor, other]));
    const res = await request(app)
      .get(`/api/v1/user/status/${other._id}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "other@example.test");
  });

  it("missing user (valid ObjectId) -> 200 {user:null}, not 404", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .get(`/api/v1/user/status/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { user: null });
  });

  it("invalid ObjectId -> 400", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .get("/api/v1/user/status/not-a-valid-id")
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid user ID format." });
  });

  it("passthrough case: dateofbirth and an unexpected legacy field survive, password never present", async () => {
    const self = {
      _id: new ObjectId(),
      email: "self@example.test",
      password: "secret-hash",
      role: "user",
      dateofbirth: "1990-01-01",
      someUnexpectedLegacyField: "legacy-value",
    };
    const app = freshApp(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/status/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.dateofbirth, "1990-01-01");
    assert.equal(res.body.user.someUnexpectedLegacyField, "legacy-value");
    assert.equal(res.body.user.password, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.user, "password"));
  });
});

describe("GET /api/v1/profile/:userId (characterization)", () => {
  it("self -> 200 with phone/passportId aliases", async () => {
    const self = {
      _id: new ObjectId(),
      email: "self@example.test",
      password: "x",
      role: "user",
      contactNo: "0123456789",
      passportNumber: "P12345",
    };
    const app = freshApp(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/profile/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user.phone, "0123456789");
    assert.equal(res.body.user.passportId, "P12345");
  });

  it("CURRENTLY cross-user -> 200, pre-fix behavior being intentionally closed by Stage 8", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor, other]));
    const res = await request(app).get(`/api/v1/profile/${other._id}`).set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 200);
  });

  it("missing user -> 404", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .get(`/api/v1/profile/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: "User not found" });
  });

  it("invalid ObjectId -> 400", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .get("/api/v1/profile/not-a-valid-id")
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid user ID" });
  });
});

describe("POST /api/v1/user/request-profile-edit (characterization)", () => {
  it("CONCRETE vulnerability: actor A's token + body.userId=B currently succeeds AND modifies B's document -- no comparison exists today", async () => {
    const actorA = { _id: new ObjectId(), email: "a@example.test", password: "x", role: "user" };
    const userB = { _id: new ObjectId(), email: "b@example.test", password: "x", role: "user", profileChangeRequestStatus: "default" };
    const collection = new FakeUsersCollection([actorA, userB]);
    const app = freshApp(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(actorA._id)}`)
      .send({ userId: userB._id.toString(), note: "please update my info" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Profile change request submitted" });
    // The actual mutation -- B's document was changed by A's request.
    const stored = collection.find().find((d) => d._id.equals(userB._id));
    assert.equal(stored?.profileChangeRequestStatus, "requested");
    assert.equal(stored?.profileEditNote, "please update my info");
  });

  it("missing/invalid userId -> 400", async () => {
    const actorA = { _id: new ObjectId(), email: "a@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actorA]));
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(actorA._id)}`)
      .send({ note: "no userId provided" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid or missing userId" });
  });

  it("modifiedCount===0 (already requested / missing target) -> 404", async () => {
    const actorA = { _id: new ObjectId(), email: "a@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actorA]));
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(actorA._id)}`)
      .send({ userId: new ObjectId().toString() });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: "User not found or already requested" });
  });

  it("truthy non-string note (e.g. 123) is accepted and persisted unchanged -- legacy imposes no note-type validation", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const collection = new FakeUsersCollection([self]);
    const app = freshApp(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ userId: self._id.toString(), note: 123 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Profile change request submitted" });
    const stored = collection.find().find((d) => d._id.equals(self._id));
    assert.strictEqual(stored?.profileEditNote, 123);
  });

  it("falsy note (null) maps to empty string via note || ''", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user" };
    const collection = new FakeUsersCollection([self]);
    const app = freshApp(collection);
    const res = await request(app)
      .post("/api/v1/user/request-profile-edit")
      .set("Authorization", `Bearer ${signToken(self._id)}`)
      .send({ userId: self._id.toString(), note: null });
    assert.equal(res.status, 200);
    const stored = collection.find().find((d) => d._id.equals(self._id));
    assert.strictEqual(stored?.profileEditNote, "");
  });
});

describe("GET /api/v1/users/with-profile-request (characterization)", () => {
  it("admin -> 200 with fixed projection", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const requester = {
      _id: new ObjectId(),
      email: "requester@example.test",
      password: "x",
      role: "user",
      profileChangeRequestStatus: "requested",
      profileEditNote: "note",
    };
    const app = freshApp(new FakeUsersCollection([admin, requester]));
    const res = await request(app)
      .get("/api/v1/users/with-profile-request")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.users.length, 1);
    assert.equal(res.body.users[0].email, "requester@example.test");
  });

  it("non-admin -> 403 (preserved, not a new Stage 8 behavior)", async () => {
    const user = { _id: new ObjectId(), email: "user@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/users/with-profile-request")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 403);
  });
});

describe("GET /api/v1/user/:userId (characterization)", () => {
  it("self -> 200 with fallback chain (lastMock present)", async () => {
    const self = {
      _id: new ObjectId(),
      email: "self@example.test",
      password: "x",
      role: "user",
      name: "Self User",
      totalMock: 5,
      mock: 3,
      status: "active",
      mocks: [{ transactionId: "TXN-OLD", mockType: "Old" }, { transactionId: "TXN-NEW", mockType: "New" }],
    };
    const app = freshApp(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.transactionId, "TXN-NEW");
    assert.equal(res.body.lastMock.transactionId, "TXN-NEW");
  });

  it("CURRENTLY cross-user -> 200, pre-fix behavior being intentionally closed by Stage 8", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const other = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor, other]));
    const res = await request(app).get(`/api/v1/user/${other._id}`).set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 200);
  });

  it("invalid ObjectId -> 400 (falls through to legacy's own catch-all)", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app).get("/api/v1/user/not-a-valid-id").set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid user ID" });
  });

  it("missing user -> 404", async () => {
    const actor = { _id: new ObjectId(), email: "actor@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .get(`/api/v1/user/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 404);
  });

  it("no mocks[] -> root fallback / N/A default, mock/totalMock zero preserved", async () => {
    const self = { _id: new ObjectId(), email: "self@example.test", password: "x", role: "user", totalMock: 0, mock: 0 };
    const app = freshApp(new FakeUsersCollection([self]));
    const res = await request(app).get(`/api/v1/user/${self._id}`).set("Authorization", `Bearer ${signToken(self._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.totalMock, 0);
    assert.equal(res.body.user.mock, 0);
    assert.equal(res.body.user.transactionId, "N/A");
    assert.equal(res.body.lastMock, null);
  });

  it("GET /user/all remains legacy-reachable (admin-only, not shadowed)", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const app = freshApp(new FakeUsersCollection([admin]));
    const res = await request(app).get("/api/v1/user/all").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});
