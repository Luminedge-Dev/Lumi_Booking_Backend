// Characterization of the current verifyToken boundary (middleware/auth.js).
// Uses fake usersCollection + a test-only JWT secret. No real credentials.
// Locks behavior only; Stage 4+ must not weaken these codes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { createTestApp, stubUsersCollection } from "../helpers/create-test-app";

process.env.JWT_SECRET = "test-only-secret";

const TEST_ID = new ObjectId().toHexString();
const PROFILE_PATH = `/api/v1/profile/${TEST_ID}`;

function signedToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string);
}

function denyDbAccess(): { findOne: () => Promise<never> } {
  return {
    findOne: async (): Promise<never> => {
      throw new Error("Unexpected database access in characterization test");
    },
  };
}

describe("auth boundary (characterization)", () => {
  it("no token -> 401 NO_TOKEN without touching the database", async () => {
    const res = await request(
      createTestApp({ usersCollection: denyDbAccess() })
    ).get(PROFILE_PATH);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Unauthorized", code: "NO_TOKEN" });
  });

  it("malformed token -> 401 INVALID_TOKEN", async () => {
    const res = await request(
      createTestApp({ usersCollection: denyDbAccess() })
    )
      .get(PROFILE_PATH)
      .set("Authorization", "Bearer not-a-valid-jwt");
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: "Invalid token", code: "INVALID_TOKEN" });
  });

  it("valid token, missing account -> 401 ACCOUNT_NOT_FOUND", async () => {
    const app = createTestApp({
      usersCollection: stubUsersCollection(async () => null),
    });
    const res = await request(app)
      .get(PROFILE_PATH)
      .set("Authorization", `Bearer ${signedToken({ userId: TEST_ID })}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      message: "Session no longer valid",
      code: "ACCOUNT_NOT_FOUND",
    });
  });

  it("valid token, deleted account -> 401 ACCOUNT_BLOCKED", async () => {
    const app = createTestApp({
      usersCollection: stubUsersCollection(async () => ({
        _id: new ObjectId(TEST_ID),
        isDeleted: true,
        status: "active",
        role: "user",
      })),
    });
    const res = await request(app)
      .get(PROFILE_PATH)
      .set("Authorization", `Bearer ${signedToken({ userId: TEST_ID })}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      message: "Session no longer valid",
      code: "ACCOUNT_BLOCKED",
    });
  });

  it("token issued before password change -> 401 TOKEN_STALE", async () => {
    const token = signedToken({ userId: TEST_ID });
    const app = createTestApp({
      usersCollection: stubUsersCollection(async () => ({
        _id: new ObjectId(TEST_ID),
        isDeleted: false,
        status: "active",
        role: "user",
        passwordChangedAt: new Date(Date.now() + 3600_000).toISOString(),
      })),
    });
    const res = await request(app)
      .get(PROFILE_PATH)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      message: "Session no longer valid",
      code: "TOKEN_STALE",
    });
  });
});
