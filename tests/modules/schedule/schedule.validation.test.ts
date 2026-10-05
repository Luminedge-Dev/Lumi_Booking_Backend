import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  isValidScheduleIdParam,
  isValidCourseIdParam,
  parseMonthParam,
  parseCreateScheduleEntry,
  normalizeIncomingSlot,
  parsePaginationParams,
  parseAdminListFilter,
} from "../../../src/app/modules/schedule/schedule.validation";

describe("isValidScheduleIdParam / isValidCourseIdParam", () => {
  it("accepts a valid ObjectId-shaped string", () => {
    assert.equal(isValidScheduleIdParam(new ObjectId().toString()), true);
    assert.equal(isValidCourseIdParam(new ObjectId().toString()), true);
  });

  it("rejects an invalid string", () => {
    assert.equal(isValidScheduleIdParam("not-a-valid-id"), false);
    assert.equal(isValidCourseIdParam("not-a-valid-id"), false);
  });

  it("rejects a non-string", () => {
    assert.equal(isValidScheduleIdParam(123), false);
    assert.equal(isValidCourseIdParam(undefined), false);
  });
});

describe("parseMonthParam", () => {
  it("parses a valid YYYY-MM into string boundaries, not Date objects", () => {
    const range = parseMonthParam("2026-10");
    assert.deepEqual(range, { startInclusive: "2026-10-01", endExclusive: "2026-11-01" });
    assert.equal(typeof range?.startInclusive, "string");
    assert.equal(typeof range?.endExclusive, "string");
  });

  it("December rolls over into January of the next year", () => {
    const range = parseMonthParam("2026-12");
    assert.deepEqual(range, { startInclusive: "2026-12-01", endExclusive: "2027-01-01" });
  });

  it("January is NOT special-cased incorrectly (sanity check adjacent to rollover)", () => {
    const range = parseMonthParam("2026-01");
    assert.deepEqual(range, { startInclusive: "2026-01-01", endExclusive: "2026-02-01" });
  });

  it("rejects month 13", () => {
    assert.equal(parseMonthParam("2026-13"), null);
  });

  it("rejects missing day/garbage/short forms", () => {
    assert.equal(parseMonthParam("2026"), null);
    assert.equal(parseMonthParam("garbage"), null);
    assert.equal(parseMonthParam(""), null);
  });

  it("rejects non-string input", () => {
    assert.equal(parseMonthParam(undefined), null);
    assert.equal(parseMonthParam(202610), null);
  });
});

describe("parseCreateScheduleEntry (tolerant, per-row compatibility parser)", () => {
  it("returns null when courseId/startDate/endDate fail the truthiness check", () => {
    assert.equal(parseCreateScheduleEntry({ startDate: "2026-10-05" }), null);
    assert.equal(parseCreateScheduleEntry({ courseId: "", startDate: "2026-10-05", endDate: "2026-10-05" }), null);
  });

  it("admissible entry with no timeSlots returns a non-null result with an empty timeSlots array (caller distinguishes this from the missing-field case)", () => {
    const result = parseCreateScheduleEntry({ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" });
    assert.ok(result);
    assert.deepEqual(result?.timeSlots, []);
  });

  it("defaults use ?? not || -- a deliberately falsy-but-non-nullish status survives", () => {
    const result = parseCreateScheduleEntry({ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", status: 0 });
    assert.strictEqual(result?.status, 0);
  });

  it("missing name/testSystem/testType/status default via ??", () => {
    const result = parseCreateScheduleEntry({ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" });
    assert.equal(result?.name, "");
    assert.equal(result?.testSystem, "");
    assert.equal(result?.testType, undefined);
    assert.equal(result?.status, "Scheduled");
  });

  it("returns RAW, un-normalized timeSlots -- normalization is schedule.service.ts's job, sequenced after findMaxSlotId", () => {
    const result = parseCreateScheduleEntry({
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      timeSlots: [{ startTime: "9:0", endTime: "17:5", slot: "3" }],
    });
    assert.deepEqual(result?.timeSlots, [{ startTime: "9:0", endTime: "17:5", slot: "3" }]);
  });

  it("non-array timeSlots is treated as empty (not thrown)", () => {
    const result = parseCreateScheduleEntry({ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: "not-an-array" });
    assert.deepEqual(result?.timeSlots, []);
  });
});

describe("normalizeIncomingSlot (legacy property-access semantics, not a strict Zod object parse)", () => {
  it("normalizes a well-formed slot: '9:0' -> '09:00:00', slot/totalSlot Number-coerced with fallback", () => {
    const result = normalizeIncomingSlot({ startTime: "9:0", endTime: "17:5", slot: "3" });
    assert.equal(result.startTime, "09:00:00");
    assert.equal(result.endTime, "17:05:00");
    assert.strictEqual(result.slot, 3);
    assert.strictEqual(result.totalSlot, 3);
  });

  it("totalSlot independently provided is used, not overridden by slot", () => {
    const result = normalizeIncomingSlot({ startTime: "09:00", endTime: "10:00", slot: 2, totalSlot: 10 });
    assert.strictEqual(result.slot, 2);
    assert.strictEqual(result.totalSlot, 10);
  });

  it("primitive slot entries (false/0/string) are property-accessible and normalize without throwing, matching legacy's boxing behavior", () => {
    const fromFalse = normalizeIncomingSlot(false);
    assert.equal(fromFalse.startTime, "00:00:00");
    assert.equal(fromFalse.endTime, "00:00:00");
    assert.strictEqual(fromFalse.slot, 0);
    assert.strictEqual(fromFalse.totalSlot, 0);

    const fromZero = normalizeIncomingSlot(0);
    assert.equal(fromZero.startTime, "00:00:00");

    const fromString = normalizeIncomingSlot("not-a-slot-object");
    assert.equal(fromString.startTime, "00:00:00");
  });

  it("null/undefined slot entries throw (property access on null/undefined), matching legacy's request-level 500 -- never silently defaulted to {}", () => {
    assert.throws(() => normalizeIncomingSlot(null));
    assert.throws(() => normalizeIncomingSlot(undefined));
  });

  it("startTime/endTime use String(v || \"\"), not String(v ?? \"\") -- a falsy-non-nullish value normalizes to empty, not the string 'false'", () => {
    const result = normalizeIncomingSlot({ startTime: false, endTime: 0 });
    assert.equal(result.startTime, "00:00:00");
    assert.equal(result.endTime, "00:00:00");
  });
});

describe("parsePaginationParams (reimplements legacy's exact parseInt+clamp arithmetic, not Zod)", () => {
  it("defaults: page=1, limit=100", () => {
    assert.deepEqual(parsePaginationParams({}), { page: 1, limit: 100, skip: 0 });
  });

  it("page clamps to minimum 1, no upper clamp", () => {
    assert.equal(parsePaginationParams({ page: "-5" }).page, 1);
    assert.equal(parsePaginationParams({ page: "99999" }).page, 99999);
  });

  it("limit clamps to [1,500]", () => {
    assert.equal(parsePaginationParams({ limit: "-5" }).limit, 1);
    assert.equal(parsePaginationParams({ limit: "99999" }).limit, 500);
  });

  it("limit=0 falls back to the 100 default (parseInt('0',10) is falsy)", () => {
    assert.equal(parsePaginationParams({ limit: "0" }).limit, 100);
  });

  it("garbage values tolerate like parseInt (e.g. '2abc' -> 2)", () => {
    assert.equal(parsePaginationParams({ page: "2abc" }).page, 2);
  });

  it("skip = (page-1)*limit", () => {
    assert.equal(parsePaginationParams({ page: "3", limit: "10" }).skip, 20);
  });
});

describe("parseAdminListFilter", () => {
  it("omits courseId/status when absent", () => {
    assert.deepEqual(parseAdminListFilter({}), {});
  });

  it("String(...)-coerces present values", () => {
    assert.deepEqual(parseAdminListFilter({ courseId: "c1", status: "Scheduled" }), { courseId: "c1", status: "Scheduled" });
  });
});
