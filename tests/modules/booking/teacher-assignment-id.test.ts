import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { teacherAssignmentId, deterministicUuidV5 } from "../../../src/app/modules/booking/teacher-assignment.id";
import { deterministicUuid } from "../../../scripts/migration/stage14/common";

// The runtime id must equal what the Stage 14 ETL wrote, byte for byte.
describe("teacher assignment deterministic id (Stage 14 parity)", () => {
  const cases = [
    ["64b7f0c2e4b0a1b2c3d4e5f6", "64b7f0c2e4b0a1b2c3d4e5f7"],
    ["000000000000000000000001", "ABCDEFABCDEFABCDEFABCDEF"],
    ["64b7f0c2e4b0a1b2c3d4e5f6", "home-legacy-key with spaces"],
  ] as const;

  it("matches the Stage 14 deterministicUuid for the same (user, raw legacy key)", () => {
    for (const [userId, key] of cases) {
      assert.equal(teacherAssignmentId(userId, key), deterministicUuid(`teacher_assignment:${userId}:${key}`));
    }
  });

  it("is a stable RFC 4122 version-5 UUID (golden vector)", () => {
    const id = teacherAssignmentId("64b7f0c2e4b0a1b2c3d4e5f6", "64b7f0c2e4b0a1b2c3d4e5f7");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id, deterministicUuidV5("teacher_assignment:64b7f0c2e4b0a1b2c3d4e5f6:64b7f0c2e4b0a1b2c3d4e5f7"));
  });

  it("different bookings or users never share an id; the raw key is case-sensitive (as the ETL keyed it)", () => {
    const a = teacherAssignmentId("64b7f0c2e4b0a1b2c3d4e5f6", "aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = teacherAssignmentId("64b7f0c2e4b0a1b2c3d4e5f6", "bbbbbbbbbbbbbbbbbbbbbbbb");
    const c = teacherAssignmentId("64b7f0c2e4b0a1b2c3d4e5f7", "aaaaaaaaaaaaaaaaaaaaaaaa");
    const d = teacherAssignmentId("64b7f0c2e4b0a1b2c3d4e5f6", "AAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(new Set([a, b, c, d]).size, 4);
  });
});
