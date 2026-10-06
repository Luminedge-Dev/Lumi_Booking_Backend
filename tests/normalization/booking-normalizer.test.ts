// Stage 10.5 (D-031) -- fixture-based tests for tools/migration/booking.normalizer.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  normalizeBookingDate,
  normalizeBookingId,
  normalizeBookingLocation,
  normalizeBookingScheduleId,
  normalizeBookingSlotId,
  normalizeBookingStatus,
  normalizeBookingTestType,
  normalizeBookingUserId,
} from "../../tools/migration/booking.normalizer";

describe("normalizeBookingId", () => {
  it("accepts an ObjectId passthrough", () => {
    const id = new ObjectId();
    const result = normalizeBookingId(id);
    assert.ok(result.ok);
    assert.ok(result.value.equals(id));
  });

  it("coerces a hex string and records a change", () => {
    const id = new ObjectId();
    const result = normalizeBookingId(id.toHexString());
    assert.ok(result.ok);
    assert.equal(result.changes.length, 1);
  });

  it("rejects a malformed shape", () => {
    const result = normalizeBookingId(42);
    assert.equal(result.ok, false);
  });
});

describe("normalizeBookingUserId", () => {
  it("accepts an ObjectId passthrough", () => {
    const id = new ObjectId();
    const result = normalizeBookingUserId(id);
    assert.ok(result.ok);
    assert.ok(result.value.equals(id));
  });

  it("coerces a hex string and records a change", () => {
    const id = new ObjectId();
    const result = normalizeBookingUserId(id.toHexString());
    assert.ok(result.ok);
    assert.equal(result.changes.length, 1);
  });

  it("rejects a malformed shape", () => {
    const result = normalizeBookingUserId(undefined);
    assert.equal(result.ok, false);
  });
});

describe("normalizeBookingScheduleId -- legitimately optional for Home bookings", () => {
  it("accepts undefined as the expected Home-booking shape, not an error", () => {
    const result = normalizeBookingScheduleId(undefined);
    assert.ok(result.ok);
    assert.equal(result.value, undefined);
  });

  it("accepts null the same way", () => {
    const result = normalizeBookingScheduleId(null);
    assert.ok(result.ok);
    assert.equal(result.value, undefined);
  });

  it("coerces a hex string and records a change", () => {
    const id = new ObjectId();
    const result = normalizeBookingScheduleId(id.toHexString());
    assert.ok(result.ok);
    assert.ok((result.value as ObjectId).equals(id));
    assert.equal(result.changes.length, 1);
  });

  it("rejects a present-but-malformed shape", () => {
    const result = normalizeBookingScheduleId("not-an-object-id");
    assert.equal(result.ok, false);
  });
});

describe("normalizeBookingSlotId -- canonicalizes to string, optional for Home bookings", () => {
  it("accepts undefined as the expected Home-booking shape", () => {
    const result = normalizeBookingSlotId(undefined);
    assert.ok(result.ok);
    assert.equal(result.value, undefined);
  });

  it("accepts a string passthrough with no change recorded", () => {
    const result = normalizeBookingSlotId("1");
    assert.ok(result.ok);
    assert.equal(result.value, "1");
    assert.deepEqual(result.changes, []);
  });

  it("stringifies the minority legacy integer shape and records a change", () => {
    const result = normalizeBookingSlotId(1);
    assert.ok(result.ok);
    assert.equal(result.value, "1");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "number");
    assert.equal(result.changes[0].canonicalType, "string");
  });

  it("rejects an empty string", () => {
    const result = normalizeBookingSlotId("");
    assert.equal(result.ok, false);
  });
});

describe("normalizeBookingDate -- canonicalizes to a YYYY-MM-DD calendar string, not Date", () => {
  it("accepts an already-canonical calendar string with no change recorded", () => {
    const result = normalizeBookingDate("2024-01-01");
    assert.ok(result.ok);
    assert.equal(result.value, "2024-01-01");
    assert.deepEqual(result.changes, []);
  });

  it("reformats the minority legacy Date shape to a calendar string and records a change", () => {
    const result = normalizeBookingDate(new Date("2024-01-01T00:00:00.000Z"));
    assert.ok(result.ok);
    assert.equal(result.value, "2024-01-01");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].observedType, "date");
    assert.equal(result.changes[0].canonicalType, "string");
  });

  it("rejects an unparseable shape", () => {
    const result = normalizeBookingDate("not-a-date");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_CALENDAR_DATE_SHAPE");
  });
});

describe("normalizeBookingStatus -- closed enum, audit-confirmed complete", () => {
  it("accepts the canonical spelling with no change recorded", () => {
    const result = normalizeBookingStatus("Present");
    assert.ok(result.ok);
    assert.equal(result.value, "Present");
    assert.deepEqual(result.changes, []);
  });

  it("folds the one known legacy alias and records a change", () => {
    const result = normalizeBookingStatus("present");
    assert.ok(result.ok);
    assert.equal(result.value, "Present");
    assert.equal(result.changes.length, 1);
  });

  it("accepts all 5 audit-confirmed canonical values", () => {
    for (const value of ["Present", "Absent", "pending", "completed", "missed"]) {
      const result = normalizeBookingStatus(value);
      assert.ok(result.ok, `expected "${value}" to be accepted`);
      assert.equal(result.value, value);
    }
  });

  it("rejects an empty string distinctly from a generic invalid value", () => {
    const result = normalizeBookingStatus("");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "EMPTY_STATUS_VALUE");
  });

  it("rejects a value outside the closed enum, never a silent pass-through", () => {
    const result = normalizeBookingStatus("Cancelled");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_STATUS_VALUE");
  });

  it("rejects a non-string shape", () => {
    const result = normalizeBookingStatus(1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});

describe("normalizeBookingTestType -- closed enum, audit-confirmed complete", () => {
  it("accepts both canonical values", () => {
    for (const value of ["Computer-Based", "Paper-Based"]) {
      const result = normalizeBookingTestType(value);
      assert.ok(result.ok);
      assert.equal(result.value, value);
    }
  });

  it("rejects a value outside the closed enum", () => {
    const result = normalizeBookingTestType("Online");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_VALUE");
  });

  it("rejects a non-string shape", () => {
    const result = normalizeBookingTestType(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });
});

describe("normalizeBookingLocation -- closed enum, missing vs malformed distinction", () => {
  it("accepts both canonical values", () => {
    for (const value of ["Home", "Test Center"]) {
      const result = normalizeBookingLocation(value);
      assert.ok(result.ok);
      assert.equal(result.value, value);
    }
  });

  it("rejects an absent value with MISSING_REQUIRED_FIELD, distinct from a malformed shape", () => {
    const result = normalizeBookingLocation(undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "MISSING_REQUIRED_FIELD");
  });

  it("treats null the same way as undefined", () => {
    const result = normalizeBookingLocation(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "MISSING_REQUIRED_FIELD");
  });

  it("rejects a non-string shape distinctly from absence", () => {
    const result = normalizeBookingLocation(42);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_SHAPE");
  });

  it("rejects a value outside the closed enum", () => {
    const result = normalizeBookingLocation("Online");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, "INVALID_ENUM_VALUE");
  });
});
