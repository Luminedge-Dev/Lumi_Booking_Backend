// Stage 10.5 (D-031) -- fixture-based tests for tools/migration/course.normalizer.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCourseTimestamp } from "../../tools/migration/course.normalizer";

describe("normalizeCourseTimestamp -- optional presence, no observed type inconsistency", () => {
  it("accepts a Date passthrough", () => {
    const input = new Date("2024-01-01T00:00:00.000Z");
    const result = normalizeCourseTimestamp("createdAt", input);
    assert.ok(result.ok);
    assert.equal(result.value?.getTime(), input.getTime());
    assert.deepEqual(result.changes, []);
  });

  it("coerces an ISO string and records a change", () => {
    const result = normalizeCourseTimestamp("updatedAt", "2024-01-01T00:00:00.000Z");
    assert.ok(result.ok);
    assert.equal(result.value?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(result.changes.length, 1);
  });

  it("accepts absence as legitimately optional (80% present only)", () => {
    const result = normalizeCourseTimestamp("createdAt", undefined);
    assert.ok(result.ok);
    assert.equal(result.value, undefined);
  });

  it("rejects an unparseable present value", () => {
    const result = normalizeCourseTimestamp("createdAt", "not-a-date");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].field, "courses.createdAt");
  });
});
