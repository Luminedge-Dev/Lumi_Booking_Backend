// Stage 10.5 (D-031) -- fixture-based tests for tools/migration/schedule.normalizer.ts.
// Fixtures are hand-built, never pulled from a real database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  normalizeScheduleCourseId,
  normalizeScheduleCreatedAt,
  normalizeScheduleStatus,
  normalizeScheduleTestType,
  normalizeScheduleTotalSlot,
} from "../../tools/migration/schedule.normalizer";

describe("normalizeScheduleCreatedAt", () => {
  it("accepts a Date passthrough with no change recorded", () => {
    const input = new Date("2024-01-01T00:00:00.000Z");
    const result = normalizeScheduleCreatedAt(input);
    assert.ok(result.ok);
    assert.equal(result.value.getTime(), input.getTime());
    assert.deepEqual(result.changes, []);
  });

  it("coerces an ISO string and records a change", () => {
    const result = normalizeScheduleCreatedAt("2024-01-01T00:00:00.000Z");
    assert.ok(result.ok);
    assert.equal(result.value.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "string");
    assert.equal(result.changes[0].canonicalType, "date");
  });

  it("rejects an unparseable shape", () => {
    const result = normalizeScheduleCreatedAt("not-a-date");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0].code, "INVALID_DATE_SHAPE");
      assert.equal(result.errors[0].observedType, "string");
    }
  });

  it("rejects a non-string, non-date shape", () => {
    const result = normalizeScheduleCreatedAt(12345);
    assert.equal(result.ok, false);
  });
});

describe("normalizeScheduleTotalSlot", () => {
  it("accepts a number passthrough with no change recorded", () => {
    const result = normalizeScheduleTotalSlot(20);
    assert.ok(result.ok);
    assert.equal(result.value, 20);
    assert.deepEqual(result.changes, []);
  });

  it("coerces a numeric string and records a change", () => {
    const result = normalizeScheduleTotalSlot("20");
    assert.ok(result.ok);
    assert.equal(result.value, 20);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "string");
    assert.equal(result.changes[0].canonicalType, "number");
  });

  it("rejects a non-numeric string", () => {
    const result = normalizeScheduleTotalSlot("twenty");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_NUMBER_SHAPE");
  });
});

describe("normalizeScheduleCourseId", () => {
  it("accepts an ObjectId passthrough with no change recorded", () => {
    const id = new ObjectId();
    const result = normalizeScheduleCourseId(id);
    assert.ok(result.ok);
    assert.ok(result.value.equals(id));
    assert.deepEqual(result.changes, []);
  });

  it("coerces a valid hex string and records a change", () => {
    const id = new ObjectId();
    const result = normalizeScheduleCourseId(id.toHexString());
    assert.ok(result.ok);
    assert.ok(result.value.equals(id));
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "string");
    assert.equal(result.changes[0].canonicalType, "objectId");
  });

  it("rejects a malformed id string", () => {
    const result = normalizeScheduleCourseId("not-an-object-id");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_OBJECT_ID_SHAPE");
  });
});

describe("normalizeScheduleTestType -- closed enum, audit-confirmed complete", () => {
  it("accepts the canonical spelling with no change recorded", () => {
    const result = normalizeScheduleTestType("Computer-Based");
    assert.ok(result.ok);
    assert.equal(result.value, "Computer-Based");
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.warnings, []);
  });

  it("accepts the other canonical value, Paper-Based", () => {
    const result = normalizeScheduleTestType("Paper-Based");
    assert.ok(result.ok);
    assert.equal(result.value, "Paper-Based");
    assert.deepEqual(result.changes, []);
  });

  it("folds the one known legacy alias and records a change", () => {
    const result = normalizeScheduleTestType("ComputerBased");
    assert.ok(result.ok);
    assert.equal(result.value, "Computer-Based");
    assert.equal(result.changes.length, 1);
  });

  it("rejects a value outside the closed enum, never a silent pass-through", () => {
    const result = normalizeScheduleTestType("Online");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_VALUE");
  });

  it("rejects a non-string shape", () => {
    const result = normalizeScheduleTestType(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});

describe("normalizeScheduleStatus -- closed enum with one documented historical anomaly", () => {
  it("accepts the canonical value Scheduled", () => {
    const result = normalizeScheduleStatus("Scheduled");
    assert.ok(result.ok);
    assert.equal(result.value, "Scheduled");
  });

  it("accepts the code-supported, unobserved canonical value Cancelled", () => {
    const result = normalizeScheduleStatus("Cancelled");
    assert.ok(result.ok);
    assert.equal(result.value, "Cancelled");
  });

  it("rejects the known historical-anomaly value 'pending' with its own specific code", () => {
    const result = normalizeScheduleStatus("pending");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "QUARANTINED_HISTORICAL_SCHEDULE_STATUS");
  });

  it("rejects a genuinely unrecognized value as UNCHARACTERIZED_ENUM_VALUE, distinct from the pending anomaly", () => {
    const result = normalizeScheduleStatus("OnHold");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "UNCHARACTERIZED_ENUM_VALUE");
  });

  it("rejects a non-string shape", () => {
    const result = normalizeScheduleStatus(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});
