// Stage 10.5 (D-031, closure patch) -- fixture-based tests for
// normalizeScheduleDocument.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { normalizeScheduleDocument } from "../../tools/migration/schedule.normalizer";

function validScheduleFixture(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    name: "IELTS Computer-Based -- Jan Batch",
    courseId: new ObjectId(),
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    testType: "Computer-Based",
    testSystem: "Academic",
    status: "Scheduled",
    startDate: "2024-02-01",
    endDate: "2024-02-01",
    timeSlots: [{ slot: 1, slotId: "1", totalSlot: 20, startTime: "09:00", endTime: "11:00" }],
    ...overrides,
  };
}

describe("normalizeScheduleDocument", () => {
  it("produces a complete canonical document with zero warnings for a fully-valid fixture", () => {
    const result = normalizeScheduleDocument(validScheduleFixture());
    assert.ok(result.ok);
    assert.equal(result.value.testType, "Computer-Based");
    assert.equal(result.value.status, "Scheduled");
    assert.equal(result.value.timeSlots.length, 1);
    assert.deepEqual(result.warnings, []);
  });

  it("drops an unexpected field not in the contract (field-leakage protection)", () => {
    const result = normalizeScheduleDocument(validScheduleFixture({ randomWrongField: "x" }));
    assert.ok(result.ok);
    assert.ok(!("randomWrongField" in result.value));
  });

  it("produces ok:false when a required field is missing", () => {
    const fixture = validScheduleFixture();
    delete (fixture as Record<string, unknown>).startDate;
    const result = normalizeScheduleDocument(fixture);
    assert.equal(result.ok, false);
  });

  it("rejects a testType value outside the closed enum at the document level", () => {
    const result = normalizeScheduleDocument(validScheduleFixture({ testType: "Online" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "INVALID_ENUM_VALUE"));
  });

  it("rejects the known historical-anomaly status 'pending' with its specific code", () => {
    const result = normalizeScheduleDocument(validScheduleFixture({ status: "pending" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "QUARANTINED_HISTORICAL_SCHEDULE_STATUS"));
  });

  it("accepts testSystem absent as legitimately optional", () => {
    const fixture = validScheduleFixture();
    delete (fixture as Record<string, unknown>).testSystem;
    const result = normalizeScheduleDocument(fixture);
    assert.ok(result.ok);
    assert.equal(result.value.testSystem, undefined);
  });

  it("fails a flattened-legacy-shaped document (missing timeSlots/courseId/startDate) at the whole-document level", () => {
    const flattened = {
      _id: new ObjectId(),
      bookingDate: "2024-01-01",
      endTime: "11:00",
      location: "Dhaka",
      scheduleId: new ObjectId().toHexString(),
      slotId: "1",
      startTime: "09:00",
      userId: new ObjectId().toHexString(),
    };
    const result = normalizeScheduleDocument(flattened);
    assert.equal(result.ok, false);
  });
});
