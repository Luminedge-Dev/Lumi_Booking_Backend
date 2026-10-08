import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../../src/app";
import type { AppDependencies } from "../../../src/app/database/database.types";
import type { AuthConfig } from "../../../src/app/modules/auth/auth.types";
import { authRateLimiter as authRateLimiterHandler } from "../../../src/app/middleware/rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { fakeCoreRepositories } from "../../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../../helpers/fake-users-repositories";
import { throwingCollection } from "../../helpers/create-test-app";
import { FakeUsersCollection } from "../../helpers/fake-users-collection";

process.env.JWT_SECRET = "test-only-secret";
const authRateLimiter = authRateLimiterHandler as unknown as RateLimitRequestHandler;
const authConfig: AuthConfig = {
  jwtSecret: "test-only-secret",
  jwtResetPasswordSecret: "test-only-reset-secret",
  jwtExpiresIn: "7d",
  jwtResetPasswordTokenExpiresIn: "15m",
  resetPasswordLink: "https://example.test/reset-password",
  isProduction: false,
};

afterEach(async () => {
  await authRateLimiter.resetKey("::ffff:127.0.0.1");
  await authRateLimiter.resetKey("127.0.0.1");
});

function appWith(users: FakeUsersCollection) {
  const dependencies: AppDependencies = {
    usersCollection: users as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, {
    corsOrigins: ["http://localhost:3000"],
    trustProxyHops: 1,
    authConfig,
    repositories: fakeCoreRepositories(usersBackedRepositories(users)),
    userNotifier: { mocksGranted() {}, accountCompleted() {} },
  });
}

function token(id: ObjectId, role = "admin", email = "admin@example.test"): string {
  return jwt.sign({ userId: id.toString(), email, role }, "test-only-secret");
}

describe("native admin PUTs (HTTP, in-memory user repo)", () => {
  it("rejects anonymous and non-admin grant", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = { _id: new ObjectId(), email: "u@example.test", password: "x", role: "user", mock: 0, totalMock: 0 };
    const app = appWith(new FakeUsersCollection([admin, user]));
    assert.equal((await request(app).put(`/api/v1/user/update-multiple/${user._id}`).send({ mocks: [{ mock: 1 }] })).status, 401);
    assert.equal(
      (
        await request(app)
          .put(`/api/v1/user/update-multiple/${user._id}`)
          .set("Authorization", `Bearer ${token(user._id, "user", user.email)}`)
          .send({ mocks: [{ mock: 1, transactionId: "a" }] })
      ).status,
      403
    );
  });

  it("grants mocks then P1 rejects a colliding mixed-case email with 409 and no mutation", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const owner = { _id: new ObjectId(), email: "Member@Example.com", password: "x", role: "user", name: "A" };
    const target = { _id: new ObjectId(), email: "other@example.test", password: "x", role: "user", name: "B", profileEditNote: "please" };
    const app = appWith(new FakeUsersCollection([admin, owner, target]));
    const granted = await request(app)
      .put(`/api/v1/user/update-multiple/${target._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ mocks: [{ mock: 3, transactionId: "MR-9", mockType: "IELTS", extraField: "drop-me" }] });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.addedMocks[0].mock, 3);

    const clash = await request(app)
      .put(`/api/v1/user/approve-profile-edit/${target._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ email: "member@example.com", name: "Hacked" });
    assert.equal(clash.status, 409);
    assert.deepEqual(clash.body, { message: "Email address already in use" });
    const still = await request(app).get(`/api/v1/user/${target._id}`).set("Authorization", `Bearer ${token(target._id, "user", target.email)}`);
    assert.equal(still.body.user.email, "other@example.test");
    assert.equal(still.body.user.name, "B");
  });

  it("same-account email is allowed; block vs status matrix", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = {
      _id: new ObjectId(),
      email: "keep@example.test",
      password: "x",
      role: "user",
      status: "blocked",
      isDeleted: false,
      name: "Keep",
    };
    const app = appWith(new FakeUsersCollection([admin, user]));
    const same = await request(app)
      .put(`/api/v1/user/approve-profile-edit/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ email: "KEEP@example.test" });
    assert.equal(same.status, 200);

    const blockedTok = token(user._id, "user", "keep@example.test");
    const stillBlocked = await request(app).get(`/api/v1/user/${user._id}`).set("Authorization", `Bearer ${blockedTok}`);
    assert.equal(stillBlocked.status, 401);
    assert.equal(stillBlocked.body.code, "ACCOUNT_BLOCKED");

    await request(app)
      .put(`/api/v1/user/status/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ status: "active" });
    const afterStatus = await request(app).get(`/api/v1/user/${user._id}`).set("Authorization", `Bearer ${blockedTok}`);
    assert.equal(afterStatus.status, 200);

    await request(app)
      .put(`/api/v1/user/block/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ isDeleted: true });
    const afterBlock = await request(app).get(`/api/v1/user/${user._id}`).set("Authorization", `Bearer ${blockedTok}`);
    assert.equal(afterBlock.status, 401);

    await request(app)
      .put(`/api/v1/user/status/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ status: "active" });
    const stillDeleted = await request(app).get(`/api/v1/user/${user._id}`).set("Authorization", `Bearer ${blockedTok}`);
    assert.equal(stillDeleted.status, 401);

    await request(app)
      .put(`/api/v1/user/block/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ isDeleted: false });
    const clear = await request(app).get(`/api/v1/user/${user._id}`).set("Authorization", `Bearer ${blockedTok}`);
    assert.equal(clear.status, 200);
  });

  it("D9 ambiguous trimmed transaction IDs return 409", async () => {
    const admin = { _id: new ObjectId(), email: "admin@example.test", password: "x", role: "admin" };
    const user = {
      _id: new ObjectId(),
      email: "u@example.test",
      password: "x",
      role: "user",
      mock: 4,
      totalMock: 4,
      mocks: [
        { transactionId: "MR-1", mock: 2 },
        { transactionId: " MR-1 ", mock: 2 },
      ],
    };
    const app = appWith(new FakeUsersCollection([admin, user]));
    const res = await request(app)
      .put(`/api/v1/user/update-one/${user._id}`)
      .set("Authorization", `Bearer ${token(admin._id)}`)
      .send({ transactionId: "MR-1", updatedMock: { mock: 1, mrValidation: "1 day" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Ambiguous transaction ID");
  });
});
