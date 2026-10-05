import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { toScheduleDto, toScheduleDtoList } from "../../../src/app/modules/schedule/schedule.mapper";
import type { ScheduleRecord } from "../../../src/app/modules/schedule/schedule.types";

describe("toScheduleDto / toScheduleDtoList (open/passthrough only)", () => {
  it("full-document passthrough: every field survives untouched", () => {
    const record: ScheduleRecord = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      name: "IELTS",
      testSystem: "Academic",
      testType: "Computer-Based",
      status: "Scheduled",
      timeSlots: [{ slotId: "1" }],
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const dto = toScheduleDto(record);
    assert.deepEqual(dto, record);
  });

  it("an unexpected/rare-shape field survives untouched (proves genuine passthrough, not a hidden allowlist)", () => {
    const record: ScheduleRecord = {
      _id: new ObjectId(),
      someRareFlattenedField: "legacy-value",
    };
    const dto = toScheduleDto(record);
    assert.equal(dto.someRareFlattenedField, "legacy-value");
  });

  it("missing fields are preserved as absent, not coerced to defaults", () => {
    const record: ScheduleRecord = { _id: new ObjectId() };
    const dto = toScheduleDto(record);
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, "timeSlots"));
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, "status"));
  });

  it("toScheduleDtoList maps every record independently", () => {
    const records: ScheduleRecord[] = [{ _id: new ObjectId(), courseId: "c1" }, { _id: new ObjectId(), courseId: "c2" }];
    const dtos = toScheduleDtoList(records);
    assert.equal(dtos.length, 2);
    assert.equal(dtos[0].courseId, "c1");
    assert.equal(dtos[1].courseId, "c2");
  });

  it("returns a shallow copy, not the same object reference (mutation safety)", () => {
    const record: ScheduleRecord = { _id: new ObjectId(), courseId: "c1" };
    const dto = toScheduleDto(record);
    assert.notEqual(dto, record);
  });
});
