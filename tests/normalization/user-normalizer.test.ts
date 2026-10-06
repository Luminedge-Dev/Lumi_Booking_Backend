// Stage 10.5 (D-031) -- fixture-based tests for tools/migration/user.normalizer.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUserDateOfBirth, normalizeUserRole, normalizeUserStatus } from "../../tools/migration/user.normalizer";

describe("normalizeUserDateOfBirth -- dateofbirth is a code-level alias, not a data-type variant", () => {
  it("prefers the canonical dateOfBirth key when present", () => {
    const result = normalizeUserDateOfBirth({ dateOfBirth: "1990-01-01", dateofbirth: "1999-12-31" });
    assert.ok(result.ok);
    assert.equal(result.value, "1990-01-01");
    assert.deepEqual(result.changes, []);
  });

  it("falls back to the dateofbirth alias and records a change", () => {
    const result = normalizeUserDateOfBirth({ dateofbirth: "1990-01-01" });
    assert.ok(result.ok);
    assert.equal(result.value, "1990-01-01");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "alias:dateofbirth");
  });

  it("accepts both keys absent as legitimately optional", () => {
    const result = normalizeUserDateOfBirth({});
    assert.ok(result.ok);
    assert.equal(result.value, undefined);
    assert.deepEqual(result.changes, []);
  });

  it("rejects a non-string canonical value", () => {
    const result = normalizeUserDateOfBirth({ dateOfBirth: 12345 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].field, "users.dateOfBirth");
  });

  it("rejects a non-string alias value", () => {
    const result = normalizeUserDateOfBirth({ dateofbirth: 12345 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].field, "users.dateofbirth");
  });

  it("semantic-consistency closure: an explicit null dateOfBirth is preserved as null, not collapsed to undefined", () => {
    const result = normalizeUserDateOfBirth({ dateOfBirth: null });
    assert.ok(result.ok);
    assert.equal(result.value, null);
  });

  it("an explicit null dateOfBirth is the canonical answer -- the dateofbirth alias is not consulted", () => {
    const result = normalizeUserDateOfBirth({ dateOfBirth: null, dateofbirth: "1990-01-01" });
    assert.ok(result.ok);
    assert.equal(result.value, null);
  });

  it("falls back to an explicit null dateofbirth alias when dateOfBirth is genuinely absent, preserving null", () => {
    const result = normalizeUserDateOfBirth({ dateofbirth: null });
    assert.ok(result.ok);
    assert.equal(result.value, null);
  });
});

describe("normalizeUserRole -- closed enum, audit-confirmed complete, no alias", () => {
  it("accepts all 4 canonical values", () => {
    for (const value of ["user", "teacher", "bdm", "admin"]) {
      const result = normalizeUserRole(value);
      assert.ok(result.ok, `expected "${value}" to be accepted`);
      assert.equal(result.value, value);
    }
  });

  it("rejects a value outside the closed enum", () => {
    const result = normalizeUserRole("superadmin");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_VALUE");
  });

  it("rejects a non-string shape", () => {
    const result = normalizeUserRole(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});

describe("normalizeUserStatus -- closed enum with one documented null anomaly", () => {
  it("accepts the 3 observed canonical values", () => {
    for (const value of ["active", "checked", "completed"]) {
      const result = normalizeUserStatus(value);
      assert.ok(result.ok, `expected "${value}" to be accepted`);
      assert.equal(result.value, value);
    }
  });

  it("accepts the code-supported, unobserved canonical value 'blocked'", () => {
    const result = normalizeUserStatus("blocked");
    assert.ok(result.ok);
    assert.equal(result.value, "blocked");
  });

  it("rejects null with a distinct code, never defaulting", () => {
    const result = normalizeUserStatus(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "NULL_STATUS_VALUE");
  });

  it("rejects a genuinely unrecognized value", () => {
    const result = normalizeUserStatus("suspended");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "UNCHARACTERIZED_ENUM_VALUE");
  });

  it("rejects a non-string, non-null shape", () => {
    const result = normalizeUserStatus(42);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});
