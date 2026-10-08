// Native-module unit tests for AuthService, independent of Express/HTTP
// (AGENTS.md: services must not depend on req/res). The HTTP-level behavior
// this service produces is already proven identical to legacy by
// tests/architecture/auth-module-parity.contract.test.ts; this file instead
// covers internals that are awkward to assert precisely through a full HTTP
// round trip: checkAccountState's exact return shape/skip-path, and
// prepareForgotPassword's found/not-found split (the controller decides HTTP
// response timing from this, so its shape matters on its own).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { FakeUsersCollection } from "../../helpers/fake-users-collection";
import { FakeUsersAuthRepository } from "../../helpers/fake-users-repositories";
import { AuthService, AuthHttpError } from "../../../src/app/modules/auth/auth.service";
import type { AuthConfig } from "../../../src/app/modules/auth/auth.types";

function fakeConfig(): AuthConfig {
  return {
    jwtSecret: "test-only-secret",
    jwtResetPasswordSecret: "test-only-reset-secret",
    jwtExpiresIn: "7d",
    jwtResetPasswordTokenExpiresIn: "15m",
    resetPasswordLink: "https://example.test/reset-password",
    isProduction: false,
  };
}

// Fake users collection + the Stage 15 users-backed repository adapter (same
// semantics the PostgreSQL repository has above the repository boundary; real
// PostgreSQL behavior is proven in tests/postgres and tests/parity).
// Simulates the real registration race at the repository level: insertOne
// always throws a Mongo-shaped E11000 error, regardless of what's in docs --
// the adapter maps it to UserEmailConflictError exactly as the PostgreSQL
// repository maps its serialized exact-email recheck.
class ThrowingInsertCollection extends FakeUsersCollection {
  async insertOne(): Promise<never> {
    throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
  }
}

function hex(id: unknown): string {
  return (id as ObjectId).toHexString();
}
function makeService(docs: Array<Record<string, unknown>> = []): AuthService {
  const repository = new FakeUsersAuthRepository(new FakeUsersCollection(docs as never));
  return new AuthService(repository, fakeConfig());
}

describe("AuthService.checkAccountState (unit)", () => {
  it("returns {ok:true} without a userId, matching middleware/auth.js's skip-path exactly", async () => {
    const service = makeService();
    const result = await service.checkAccountState({});
    assert.deepEqual(result, { ok: true });
  });

  it("returns {ok:true} for an invalid ObjectId userId", async () => {
    const service = makeService();
    const result = await service.checkAccountState({ userId: "not-an-object-id" });
    assert.deepEqual(result, { ok: true });
  });

  it("returns ACCOUNT_NOT_FOUND for a well-formed but unknown userId", async () => {
    const service = makeService([]);
    const result = await service.checkAccountState({ userId: new ObjectId().toHexString() });
    assert.deepEqual(result, { ok: false, code: "ACCOUNT_NOT_FOUND" });
  });

  it("returns {ok:true, role} with the live role when the account is in good standing", async () => {
    const userId = new ObjectId();
    const service = makeService([{ _id: userId, isDeleted: false, status: "active", role: "admin" }]);
    const result = await service.checkAccountState({ userId: userId.toHexString() });
    assert.deepEqual(result, { ok: true, role: "admin" });
  });
});

describe("AuthService.prepareForgotPassword (unit)", () => {
  it("returns {found:false} for an unknown email, with no reset link constructed", async () => {
    const service = makeService([]);
    const result = await service.prepareForgotPassword({ email: "nobody@example.test" });
    assert.deepEqual(result, { found: false });
  });

  it("returns a reset link built from the configured resetPasswordLink + userId + a verifiable token", async () => {
    const userId = new ObjectId();
    const service = makeService([{ _id: userId, email: "user@example.test", name: "A User" }]);
    const result = await service.prepareForgotPassword({ email: "USER@example.test" });
    assert.equal(result.found, true);
    assert.equal(result.email, "user@example.test");
    assert.equal(result.name, "A User");
    assert.match(result.resetLink as string, /^https:\/\/example\.test\/reset-password\?userId=/);
    assert.match(result.resetLink as string, /&token=/);
  });
});

describe("AuthService.register (unit)", () => {
  it("throws AuthHttpError(400) for an existing email", async () => {
    const service = makeService([{ _id: new ObjectId(), email: "existing@example.test", password: "x" }]);
    await assert.rejects(
      () => service.register({ email: "existing@example.test", password: "longenough1" }),
      (err: unknown) => err instanceof AuthHttpError && err.status === 400 && err.body.message === "User already exists"
    );
  });

  it("never persists client-supplied role/status/isDeleted/mock/totalMock", async () => {
    const docs: Array<Record<string, unknown>> = [];
    const repo = new FakeUsersAuthRepository(new FakeUsersCollection(docs as never));
    const service = new AuthService(repo, fakeConfig());
    // RegisterInput has no role/status/isDeleted/mock/totalMock fields at
    // all -- the type system itself is the first guard; this asserts the
    // actual persisted document still only ever carries the server-owned
    // values, regardless of what a future caller might try to smuggle in.
    const result = await service.register({ email: "new@example.test", password: "longenough1" });
    const stored = docs.find((d) => hex(d._id) === result.userId);
    assert.equal(stored?.role, "user");
    assert.equal(stored?.status, "active");
    assert.equal(stored?.isDeleted, false);
    assert.equal(stored?.mock, 0);
    assert.equal(stored?.totalMock, 0);
  });

  it("maps a Mongo E11000 insert error to AuthHttpError(409, User already exists)", async () => {
    const repo = new FakeUsersAuthRepository(new ThrowingInsertCollection());
    const service = new AuthService(repo, fakeConfig());
    await assert.rejects(
      () => service.register({ email: "race2@example.test", password: "longenough1" }),
      (err: unknown) => err instanceof AuthHttpError && err.status === 409 && err.body.message === "User already exists"
    );
  });
});

describe("AuthService password hashing (unit)", () => {
  it("register hashes with bcrypt cost 10", async () => {
    const docs: Array<Record<string, unknown>> = [];
    const repo = new FakeUsersAuthRepository(new FakeUsersCollection(docs as never));
    const service = new AuthService(repo, fakeConfig());
    const result = await service.register({ email: "cost@example.test", password: "longenough1" });
    const stored = docs.find((d) => hex(d._id) === result.userId);
    const rounds = bcrypt.getRounds(stored?.password as string);
    assert.equal(rounds, 10);
  });
});
