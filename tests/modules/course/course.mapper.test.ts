import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { toCourseDto } from "../../../src/app/modules/course/course.mapper";
import type { CourseRecord } from "../../../src/app/modules/course/course.types";

describe("toCourseDto (open passthrough, not a narrow allowlist)", () => {
  it("full 6-field passthrough", () => {
    const record: CourseRecord = {
      _id: new ObjectId(),
      name: "IELTS",
      image: "ielts.png",
      homeBasedSystems: ["windows"],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dto = toCourseDto(record);
    assert.equal(dto.name, "IELTS");
    assert.deepEqual(dto.homeBasedSystems, ["windows"]);
  });

  it("missing homeBasedSystems preserved as absent, not coerced to []", () => {
    const record: CourseRecord = { _id: new ObjectId(), name: "TOEFL" };
    const dto = toCourseDto(record);
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, "homeBasedSystems"));
  });

  it("an unexpected 7th field survives mapping untouched", () => {
    const record: CourseRecord = { _id: new ObjectId(), name: "PTE", futureField: "value" };
    const dto = toCourseDto(record);
    assert.equal((dto as Record<string, unknown>).futureField, "value");
  });
});
