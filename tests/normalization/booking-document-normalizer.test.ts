// Stage 10.5 (D-031, closure patch) -- fixture-based tests for
// normalizeBookingDocument.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { normalizeBookingDocument } from "../../tools/migration/booking.normalizer";

function validTestCenterBookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    scheduleId: new ObjectId(),
    slotId: "1",
    name: "IELTS Academic",
    location: "Test Center",
    bookingDate: "2024-02-01",
    status: "Present",
    attendance: "present",
    testType: "Computer-Based",
    testSystem: "Academic",
    startTime: "09:00",
    endTime: "11:00",
    ...overrides,
  };
}

function validHomeBookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    name: "IELTS Academic",
    location: "Home",
    bookingDate: "2024-02-01",
    status: "pending",
    testType: "Computer-Based",
    testTime: "09:00",
    ...overrides,
  };
}

describe("normalizeBookingDocument", () => {
  it("produces a complete canonical document with zero warnings for a fully-valid Test Center fixture", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture());
    assert.ok(result.ok);
    assert.equal(result.value.status, "Present");
    assert.equal(result.value.testType, "Computer-Based");
    assert.ok(result.value.scheduleId instanceof ObjectId);
    assert.deepEqual(result.warnings, []);
  });

  it("accepts a Home booking with scheduleId/slotId legitimately absent", () => {
    const result = normalizeBookingDocument(validHomeBookingFixture());
    assert.ok(result.ok);
    assert.equal(result.value.scheduleId, undefined);
    assert.equal(result.value.slotId, undefined);
  });

  it("drops an unexpected field not in the contract (field-leakage protection)", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture({ randomWrongField: "x" }));
    assert.ok(result.ok);
    assert.ok(!("randomWrongField" in result.value));
  });

  it("produces ok:false when a required field is missing", () => {
    const fixture = validTestCenterBookingFixture();
    delete (fixture as Record<string, unknown>).bookingDate;
    const result = normalizeBookingDocument(fixture);
    assert.equal(result.ok, false);
  });

  it("rejects a status value outside the closed enum at the document level, never a silent pass-through", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture({ status: "Cancelled" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_STATUS_VALUE"));
  });

  it("rejects a testType value outside the closed enum at the document level", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture({ testType: "Online" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_ENUM_VALUE"));
  });

  it("accepts all 5 audit-confirmed canonical status values at the document level", () => {
    for (const status of ["Present", "Absent", "pending", "completed", "missed"]) {
      const result = normalizeBookingDocument(validTestCenterBookingFixture({ status }));
      assert.ok(result.ok, `expected status "${status}" to produce a valid canonical document`);
    }
  });

  it("carries name/location/attendance through into the canonical output", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture());
    assert.ok(result.ok);
    assert.equal(result.value.name, "IELTS Academic");
    assert.equal(result.value.location, "Test Center");
    assert.equal(result.value.attendance, "present");
  });

  it("rejects a location value outside the closed enum", () => {
    const result = normalizeBookingDocument(validTestCenterBookingFixture({ location: "Online" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_ENUM_VALUE"));
  });

  it("distinguishes a missing location (historical record) from a malformed one", () => {
    const fixture = validTestCenterBookingFixture();
    delete (fixture as Record<string, unknown>).location;
    const result = normalizeBookingDocument(fixture);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "MISSING_REQUIRED_FIELD" && e.field === "bookingMock.location"));
  });

  it("distinguishes a missing name from a malformed one", () => {
    const fixture = validTestCenterBookingFixture();
    delete (fixture as Record<string, unknown>).name;
    const result = normalizeBookingDocument(fixture);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "MISSING_REQUIRED_FIELD" && e.field === "bookingMock.name"));
  });

  it("semantic-consistency closure: testSystem: null survives as null, distinct from absent (booking.routes.js:294 writes this exact value)", () => {
    const withNull = normalizeBookingDocument(validTestCenterBookingFixture({ testSystem: null }));
    assert.ok(withNull.ok);
    assert.equal(withNull.value.testSystem, null);

    const fixture = validTestCenterBookingFixture();
    delete (fixture as Record<string, unknown>).testSystem;
    const withoutKey = normalizeBookingDocument(fixture);
    assert.ok(withoutKey.ok);
    assert.equal(withoutKey.value.testSystem, undefined);
  });
});
