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

function sign(userId: ObjectId, role = "admin"): string {
  return jwt.sign({ userId: userId.toString(), email: "admin@example.test", role }, "test-only-secret");
}

describe("legacy PUT /user/update-multiple/:userId (characterization)", () => {
  it("admin grant pushes mocks and increments counters", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = { _id: new ObjectId(), email: "u@example.test", password: "x", role: "user", name: "Stu", mock: 1, totalMock: 1, mocks: [] };
    const app = freshApp(new FakeUsersCollection([admin, user]));
    const res = await request(app)
      .put(`/api/v1/user/update-multiple/${user._id}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ mocks: [{ mock: 2, transactionId: "MR-1", mockType: "IELTS", testType: "Computer-Based", mrValidation: "6 months" }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.message, /email notification is being sent/);
    assert.equal(res.body.addedMocks[0].mock, 2);
  });

  it("non-admin -> 403", async () => {
    const actor = { _id: new ObjectId(), email: "u@example.test", password: "x", role: "user" };
    const app = freshApp(new FakeUsersCollection([actor]));
    const res = await request(app)
      .put(`/api/v1/user/update-multiple/${actor._id}`)
      .set("Authorization", `Bearer ${sign(actor._id, "user")}`)
      .send({ mocks: [{ mock: 1, transactionId: "x" }] });
    assert.equal(res.status, 403);
  });
});

describe("legacy PUT /user/update-one/:userId (characterization)", () => {
  it("adjusts a matching trimmed transactionId and restores totalMock floor", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = {
      _id: new ObjectId(),
      email: "u@example.test",
      password: "x",
      role: "user",
      mock: 2,
      totalMock: 2,
      mocks: [{ transactionId: " MR-1 ", mock: 2, mockType: "IELTS" }],
    };
    const app = freshApp(new FakeUsersCollection([admin, user]));
    const tooLow = await request(app)
      .put(`/api/v1/user/update-one/${user._id}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ transactionId: "MR-1", updatedMock: { mock: -1, mrValidation: "1 day" } });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.body.message, "Total mock count cannot go below zero");
  });
});

describe("legacy PUT /user/status and /user/block (characterization)", () => {
  it("status and block contracts", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = { _id: new ObjectId(), email: "u@example.test", password: "x", role: "user", status: "active", isDeleted: false };
    const app = freshApp(new FakeUsersCollection([admin, user]));
    const bad = await request(app)
      .put(`/api/v1/user/status/${user._id}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ status: "nope" });
    assert.equal(bad.status, 400);
    const ok = await request(app)
      .put(`/api/v1/user/status/${user._id}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ status: "checked" });
    assert.equal(ok.status, 200);
    const blocked = await request(app)
      .put(`/api/v1/user/block/${user._id}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ isDeleted: "true" });
    assert.equal(blocked.status, 200);
    assert.match(blocked.body.message, /blocked successfully/);
  });
});

describe("legacy PUT /user/approve-profile-edit (characterization)", () => {
  it("invalid email 400; missing user 404", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const app = freshApp(new FakeUsersCollection([admin]));
    const bad = await request(app)
      .put(`/api/v1/user/approve-profile-edit/${new ObjectId()}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ email: "not-an-email" });
    assert.equal(bad.status, 400);
    const missing = await request(app)
      .put(`/api/v1/user/approve-profile-edit/${new ObjectId()}`)
      .set("Authorization", `Bearer ${sign(admin._id)}`)
      .send({ name: "A" });
    assert.equal(missing.status, 404);
  });
});
