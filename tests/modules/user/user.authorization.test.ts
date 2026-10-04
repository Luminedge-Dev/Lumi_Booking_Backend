// Direct unit tests for src/app/modules/user/user.authorization.ts's pure
// predicates -- no Express, no I/O. This is where the request-profile-edit
// authorization decision (actor-vs-body-userId) is actually proven; the
// service/controller never re-implement it (see user.service.ts's header
// comment).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  canAccessProfile,
  canAccessUserStatus,
  canAccessUserSummary,
  canRequestProfileEdit,
  isSelf,
  isStaff,
} from "../../../src/app/modules/user/user.authorization";
import type { AuthActor } from "../../../src/app/modules/user/user.types";

const selfId = new ObjectId().toHexString();
const otherId = new ObjectId().toHexString();

function actor(overrides: Partial<AuthActor> = {}): AuthActor {
  return { userId: selfId, role: "user", ...overrides };
}

describe("isSelf / isStaff (unit)", () => {
  it("isSelf: true for matching ObjectId strings, including mixed case", () => {
    assert.equal(isSelf(actor({ userId: selfId.toUpperCase() }), selfId), true);
  });
  it("isSelf: false for a different user", () => {
    assert.equal(isSelf(actor(), otherId), false);
  });
  it("isSelf: false when actor.userId is missing", () => {
    assert.equal(isSelf(actor({ userId: undefined }), selfId), false);
  });
  it("isSelf: false when actor.userId is not a valid ObjectId", () => {
    assert.equal(isSelf(actor({ userId: "not-an-object-id" }), selfId), false);
  });
  it("isSelf: false when targetUserId is not a valid ObjectId", () => {
    assert.equal(isSelf(actor(), "not-an-object-id"), false);
  });
  it("isStaff: true for admin/bdm/teacher", () => {
    for (const role of ["admin", "bdm", "teacher"]) {
      assert.equal(isStaff(actor({ role })), true);
    }
  });
  it("isStaff: false for a normal user", () => {
    assert.equal(isStaff(actor({ role: "user" })), false);
  });
  it("isStaff: false when role is missing", () => {
    assert.equal(isStaff(actor({ role: undefined })), false);
  });
});

describe("canAccessUserStatus / canAccessUserSummary (self-or-staff)", () => {
  for (const predicate of [canAccessUserStatus, canAccessUserSummary]) {
    it(`${predicate.name}: self -> true`, () => {
      assert.equal(predicate(actor({ userId: selfId }), selfId), true);
    });
    it(`${predicate.name}: admin targeting another user -> true`, () => {
      assert.equal(predicate(actor({ userId: selfId, role: "admin" }), otherId), true);
    });
    it(`${predicate.name}: bdm targeting another user -> true`, () => {
      assert.equal(predicate(actor({ userId: selfId, role: "bdm" }), otherId), true);
    });
    it(`${predicate.name}: teacher targeting another user -> true`, () => {
      assert.equal(predicate(actor({ userId: selfId, role: "teacher" }), otherId), true);
    });
    it(`${predicate.name}: normal user targeting another user -> false`, () => {
      assert.equal(predicate(actor({ userId: selfId, role: "user" }), otherId), false);
    });
    it(`${predicate.name}: missing actor.userId -> false, even for an admin role`, () => {
      assert.equal(predicate(actor({ userId: undefined, role: "admin" }), otherId), false);
    });
    it(`${predicate.name}: invalid (non-ObjectId) actor.userId -> false`, () => {
      assert.equal(predicate(actor({ userId: "bad-id", role: "admin" }), otherId), false);
    });
    it(`${predicate.name}: missing actor.role, not self -> false`, () => {
      assert.equal(predicate(actor({ userId: selfId, role: undefined }), otherId), false);
    });
  }
});

describe("canAccessProfile (self-only, even for staff)", () => {
  it("self -> true", () => {
    assert.equal(canAccessProfile(actor({ userId: selfId }), selfId), true);
  });
  it("admin targeting another user -> false", () => {
    assert.equal(canAccessProfile(actor({ userId: selfId, role: "admin" }), otherId), false);
  });
  it("bdm targeting another user -> false", () => {
    assert.equal(canAccessProfile(actor({ userId: selfId, role: "bdm" }), otherId), false);
  });
  it("teacher targeting another user -> false", () => {
    assert.equal(canAccessProfile(actor({ userId: selfId, role: "teacher" }), otherId), false);
  });
  it("normal user targeting another user -> false", () => {
    assert.equal(canAccessProfile(actor({ userId: selfId, role: "user" }), otherId), false);
  });
  it("missing actor.userId -> false", () => {
    assert.equal(canAccessProfile(actor({ userId: undefined }), selfId), false);
  });
});

describe("canRequestProfileEdit (self-only -- this proves the request-profile-edit security fix)", () => {
  it("actor A targeting their own id (body.userId===actor.userId) -> true", () => {
    assert.equal(canRequestProfileEdit(actor({ userId: selfId }), selfId), true);
  });
  it("actor A targeting user B (body.userId=B) -> false, the exact vulnerability being closed", () => {
    assert.equal(canRequestProfileEdit(actor({ userId: selfId, role: "user" }), otherId), false);
  });
  it("admin targeting another user's body.userId -> false (self-only even for staff)", () => {
    assert.equal(canRequestProfileEdit(actor({ userId: selfId, role: "admin" }), otherId), false);
  });
  it("missing actor.userId -> false", () => {
    assert.equal(canRequestProfileEdit(actor({ userId: undefined }), otherId), false);
  });
  it("invalid (non-ObjectId) actor.userId -> false", () => {
    assert.equal(canRequestProfileEdit(actor({ userId: "bad-id" }), otherId), false);
  });
});
