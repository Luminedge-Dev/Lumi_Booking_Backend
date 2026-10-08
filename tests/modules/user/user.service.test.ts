// Direct unit tests for src/app/modules/user/user.service.ts. Authorization
// is NOT this layer's job (it already ran in the route middleware chain by
// the time these methods execute -- see user.authorization.test.ts for the
// actor-vs-target proofs). These tests only cover the already-authorized
// workflow: repository orchestration + mapping.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { FakeUsersCollection } from "../../helpers/fake-users-collection";
import { FakeUsersUserRepository } from "../../helpers/fake-users-repositories";
import { UserService } from "../../../src/app/modules/user/user.service";

function makeService(docs: Array<Record<string, unknown>> = []) {
  const repository = new FakeUsersUserRepository(new FakeUsersCollection(docs as never));
  return new UserService(repository);
}

describe("UserService.getUserStatus (authorized workflow)", () => {
  it("returns the full document minus password for a known user", async () => {
    const id = new ObjectId();
    const service = makeService([{ _id: id, email: "user@example.test", password: "hash" }]);
    const result = await service.getUserStatus(id.toHexString());
    assert.equal(result.user?.email, "user@example.test");
    assert.equal(result.user?.password, undefined);
  });

  it("returns {user:null} for a missing user, not an error", async () => {
    const service = makeService([]);
    const result = await service.getUserStatus(new ObjectId().toHexString());
    assert.deepEqual(result, { user: null });
  });
});

describe("UserService.getProfile (authorized workflow)", () => {
  it("returns the narrow DTO with aliases for a known user", async () => {
    const id = new ObjectId();
    const service = makeService([{ _id: id, email: "a@b.test", contactNo: "0123", passportNumber: "P1" }]);
    const profile = await service.getProfile(id.toHexString());
    assert.equal(profile?.phone, "0123");
    assert.equal(profile?.passportId, "P1");
  });

  it("returns null for a missing user", async () => {
    const service = makeService([]);
    const profile = await service.getProfile(new ObjectId().toHexString());
    assert.equal(profile, null);
  });
});

describe("UserService.getUserSummary (authorized workflow)", () => {
  it("returns the mapped summary for a known user", async () => {
    const id = new ObjectId();
    const service = makeService([{ _id: id, name: "A", mocks: [{ transactionId: "T1" }] }]);
    const summary = await service.getUserSummary(id.toHexString());
    assert.equal(summary?.user.name, "A");
    assert.equal(summary?.lastMock?.transactionId, "T1");
  });

  it("returns null for a missing user", async () => {
    const service = makeService([]);
    const summary = await service.getUserSummary(new ObjectId().toHexString());
    assert.equal(summary, null);
  });
});

describe("UserService.requestProfileEdit (authorized workflow -- actor-vs-target already verified by this point)", () => {
  it("modifiedCount>0 -> {modified:true}", async () => {
    const id = new ObjectId();
    const service = makeService([{ _id: id, profileChangeRequestStatus: "default" }]);
    const result = await service.requestProfileEdit(id.toHexString(), "please update");
    assert.deepEqual(result, { modified: true });
  });

  it("modifiedCount===0 -> {modified:false}", async () => {
    const service = makeService([]);
    const result = await service.requestProfileEdit(new ObjectId().toHexString(), "");
    assert.deepEqual(result, { modified: false });
  });
});

describe("UserService.listProfileEditRequests (admin-only list, no actor comparison)", () => {
  it("returns all profileChangeRequestStatus:requested users", async () => {
    const service = makeService([{ _id: new ObjectId(), profileChangeRequestStatus: "requested", name: "A" }]);
    const results = await service.listProfileEditRequests();
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "A");
  });
});
