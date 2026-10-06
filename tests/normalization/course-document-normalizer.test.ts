// Stage 10.5 (D-031, closure patch) -- fixture-based tests for
// normalizeCourseDocument, proving the whole-document normalizer explicitly
// constructs the canonical object rather than spreading the raw input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { normalizeCourseDocument } from "../../tools/migration/course.normalizer";

function validCourseFixture(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    name: "IELTS Academic",
    image: "https://example.com/ielts.png",
    homeBasedSystems: ["Zoom"],
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("normalizeCourseDocument", () => {
  it("produces a complete canonical document with zero warnings for a fully-valid fixture", () => {
    const result = normalizeCourseDocument(validCourseFixture());
    assert.ok(result.ok);
    assert.equal(result.value.name, "IELTS Academic");
    assert.deepEqual(result.value.homeBasedSystems, ["Zoom"]);
    assert.deepEqual(result.warnings, []);
  });

  it("drops an unexpected field not in the contract (field-leakage protection)", () => {
    const result = normalizeCourseDocument(validCourseFixture({ randomWrongField: "x" }));
    assert.ok(result.ok);
    assert.ok(!("randomWrongField" in result.value));
  });

  it("defaults homeBasedSystems to [] when absent, recording a change", () => {
    const fixture = validCourseFixture();
    delete (fixture as Record<string, unknown>).homeBasedSystems;
    const result = normalizeCourseDocument(fixture);
    assert.ok(result.ok);
    assert.deepEqual(result.value.homeBasedSystems, []);
    assert.equal(result.changes.some((c) => c.field === "courses.homeBasedSystems"), true);
  });

  it("produces ok:false when a required field is missing", () => {
    const fixture = validCourseFixture();
    delete (fixture as Record<string, unknown>).name;
    const result = normalizeCourseDocument(fixture);
    assert.equal(result.ok, false);
  });

  it("accepts createdAt/updatedAt absent (80% present only)", () => {
    const fixture = validCourseFixture();
    delete (fixture as Record<string, unknown>).createdAt;
    delete (fixture as Record<string, unknown>).updatedAt;
    const result = normalizeCourseDocument(fixture);
    assert.ok(result.ok);
    assert.equal(result.value.createdAt, undefined);
    assert.equal(result.value.updatedAt, undefined);
  });
});
