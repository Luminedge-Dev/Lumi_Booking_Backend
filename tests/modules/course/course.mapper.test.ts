import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCourseDto } from "../../../src/app/modules/course/course.mapper";
import type { CourseRecord } from "../../../src/app/modules/course/course.types";

const HEX = "6713f7ab0123456789abcdef";

describe("toCourseDto (open passthrough, not a narrow allowlist)", () => {
  it("full 6-field passthrough", () => {
    const record: CourseRecord = {
      _id: HEX,
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

  it("does not coerce or add fields (an absent optional timestamp stays absent)", () => {
    const record: CourseRecord = { _id: HEX, name: "TOEFL", image: "t.png", homeBasedSystems: [] };
    const dto = toCourseDto(record);
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, "createdAt"));
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, "updatedAt"));
  });

  it("an extra field on the record survives mapping untouched", () => {
    const record = { _id: HEX, name: "PTE", image: "p.png", homeBasedSystems: [], futureField: "value" } as CourseRecord;
    const dto = toCourseDto(record);
    assert.equal((dto as Record<string, unknown>).futureField, "value");
  });
});
