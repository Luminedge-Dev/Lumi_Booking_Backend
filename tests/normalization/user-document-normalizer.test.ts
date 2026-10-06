// Stage 10.5 (D-031, closure patch) -- fixture-based tests for
// normalizeUserDocument, including the EXCLUDE/QUARANTINE
// targetDisposition behaviors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { normalizeUserDocument } from "../../tools/migration/user.normalizer";

function validUserFixture(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    name: "Jane Doe",
    email: "student@example.com",
    role: "user",
    status: "active",
    isDeleted: false,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    password: "hashed-password",
    mock: 2,
    totalMock: 5,
    dateOfBirth: "1995-06-15",
    contactNo: "01700000000",
    passportNumber: "A12345678",
    sex: "F",
    result: [],
    mocks: [
      {
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        mock: 1,
        mockType: "IELTS Academic",
        mrValidation: "2024-06-01",
        testSystem: "Academic",
        testType: "Computer-Based",
        transactionId: "TXN-1",
      },
    ],
    profileChangeRequestStatus: "default",
    profileEditNote: null,
    ...overrides,
  };
}

describe("normalizeUserDocument", () => {
  it("produces a complete canonical document with zero warnings for a fully-valid fixture", () => {
    const result = normalizeUserDocument(validUserFixture());
    assert.ok(result.ok);
    assert.equal(result.value.email, "student@example.com");
    assert.equal(result.value.role, "user");
    assert.equal(result.value.status, "active");
    assert.deepEqual(result.warnings, []);
  });

  it("drops an unexpected field not in the contract (field-leakage protection)", () => {
    const result = normalizeUserDocument(validUserFixture({ randomWrongField: "x" }));
    assert.ok(result.ok);
    assert.ok(!("randomWrongField" in result.value));
  });

  it("omits an EXCLUDE field (users.\" testType\") from the canonical output entirely", () => {
    const result = normalizeUserDocument(validUserFixture({ " testType": "legacy-value" }));
    assert.ok(result.ok);
    assert.ok(!(" testType" in result.value));
  });

  it("surfaces a QUARANTINE field (nameLower) in the quarantined map, absent from the main canonical object", () => {
    const result = normalizeUserDocument(validUserFixture({ nameLower: "jane doe" }));
    assert.ok(result.ok);
    assert.ok(!("nameLower" in result.value));
    assert.ok(result.quarantined.some((q) => q.field === "users.nameLower"));
  });

  it("produces ok:false when a required field is missing", () => {
    const fixture = validUserFixture();
    delete (fixture as Record<string, unknown>).email;
    const result = normalizeUserDocument(fixture);
    assert.equal(result.ok, false);
  });

  it("rejects an audited legacy-null status with the distinct NULL_STATUS_VALUE code, never defaulting", () => {
    const result = normalizeUserDocument(validUserFixture({ status: null }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "NULL_STATUS_VALUE"));
  });

  it("rejects a role value outside the closed enum at the document level", () => {
    const result = normalizeUserDocument(validUserFixture({ role: "superadmin" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_ENUM_VALUE"));
  });

  it("copies the *BySchedule maps through unchanged (PRESERVE) when present", () => {
    const fixture = validUserFixture({
      feedbackStatusBySchedule: { "sched-1": { listening: true } },
    });
    const result = normalizeUserDocument(fixture);
    assert.ok(result.ok);
    assert.deepEqual(result.value.feedbackStatusBySchedule, { "sched-1": { listening: true } });
  });

  it("falls back to the dateofbirth alias and records a change", () => {
    const fixture = validUserFixture();
    delete (fixture as Record<string, unknown>).dateOfBirth;
    (fixture as Record<string, unknown>).dateofbirth = "1995-06-15";
    const result = normalizeUserDocument(fixture);
    assert.ok(result.ok);
    assert.equal(result.value.dateOfBirth, "1995-06-15");
    assert.equal(result.changes.some((c) => c.observedType === "alias:dateofbirth"), true);
  });

  it("carries name/contactNo/passportNumber/mocks/profile fields/sex/testType through into the canonical output", () => {
    const result = normalizeUserDocument(validUserFixture({ testType: "Computer-Based" }));
    assert.ok(result.ok);
    assert.equal(result.value.name, "Jane Doe");
    assert.equal(result.value.contactNo, "01700000000");
    assert.equal(result.value.passportNumber, "A12345678");
    assert.equal(result.value.sex, "F");
    assert.equal(result.value.profileChangeRequestStatus, "default");
    assert.equal(result.value.testType, "Computer-Based");
    assert.deepEqual(result.value.mocks, [
      {
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        mock: 1,
        mockType: "IELTS Academic",
        mrValidation: "2024-06-01",
        testSystem: "Academic",
        testType: "Computer-Based",
        transactionId: "TXN-1",
      },
    ]);
  });

  it("distinguishes a missing name (historical record) from a malformed one", () => {
    const fixture = validUserFixture();
    delete (fixture as Record<string, unknown>).name;
    const result = normalizeUserDocument(fixture);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "MISSING_REQUIRED_FIELD" && e.field === "users.name"));
  });

  it("does not collide a leading-space users.\" testType\" (EXCLUDE) with the new canonical users.testType field", () => {
    const result = normalizeUserDocument(
      validUserFixture({ testType: "Computer-Based", " testType": "legacy-garbage" })
    );
    assert.ok(result.ok);
    assert.equal(result.value.testType, "Computer-Based");
    assert.ok(!(" testType" in result.value));
  });

  describe("semantic-consistency closure -- users.result's corrected array type and real null preservation", () => {
    it("result: [] survives unchanged", () => {
      const result = normalizeUserDocument(validUserFixture({ result: [] }));
      assert.ok(result.ok);
      assert.deepEqual(result.value.result, []);
    });

    it("result: [...] with entries survives unchanged, no element schema invented", () => {
      const result = normalizeUserDocument(validUserFixture({ result: ["pass", { score: 7 }] }));
      assert.ok(result.ok);
      assert.deepEqual(result.value.result, ["pass", { score: 7 }]);
    });

    it("result: null survives as null (nullable: true is semantically real)", () => {
      const result = normalizeUserDocument(validUserFixture({ result: null }));
      assert.ok(result.ok);
      assert.equal(result.value.result, null);
    });

    it("a malformed (non-array, non-null) result fails", () => {
      const result = normalizeUserDocument(validUserFixture({ result: "not-an-array" }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_ARRAY_SHAPE" && e.field === "users.result"));
    });

    it("profileEditNote: null survives as null, distinct from absent", () => {
      const withNull = normalizeUserDocument(validUserFixture({ profileEditNote: null }));
      assert.ok(withNull.ok);
      assert.equal(withNull.value.profileEditNote, null);

      const fixture = validUserFixture();
      delete (fixture as Record<string, unknown>).profileEditNote;
      const withoutKey = normalizeUserDocument(fixture);
      assert.ok(withoutKey.ok);
      assert.equal(withoutKey.value.profileEditNote, undefined);
    });

    it("contactNo/passportNumber/sex/transactionId: null each survive as null", () => {
      const result = normalizeUserDocument(
        validUserFixture({ contactNo: null, passportNumber: null, sex: null, transactionId: null })
      );
      assert.ok(result.ok);
      assert.equal(result.value.contactNo, null);
      assert.equal(result.value.passportNumber, null);
      assert.equal(result.value.sex, null);
      assert.equal(result.value.transactionId, null);
    });
  });
});
