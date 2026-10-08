import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScheduleService } from "../../../src/app/modules/schedule/schedule.service";
import type { ScheduleRecord, SlotIdKey } from "../../../src/app/modules/schedule/schedule.types";
import { newObjectIdHex } from "../../../src/app/shared/utils/object-id";
import { FakeScheduleRepository, TimeoutScheduleRepository, scheduleRecord } from "../../helpers/fake-core-repositories";

function makeService(records: ScheduleRecord[] = []): { service: ScheduleService; repository: FakeScheduleRepository } {
  const repository = new FakeScheduleRepository(records);
  return { service: new ScheduleService(repository), repository };
}

const COURSE = newObjectIdHex();

function entry(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    testType: "Computer-Based",
    timeSlots: [{ startTime: "09:00", endTime: "10:00" }],
    ...overrides,
  };
}

describe("ScheduleService.createSchedules -- partial-batch orchestration", () => {
  it("continues past an expected validation failure (missing field), zero successes", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([{ startDate: "2026-10-05" }]);
    assert.equal(result.successful.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].message, "Missing courseId/startDate/endDate");
  });

  it("continues past an expected validation failure (no timeSlots)", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([entry({ timeSlots: undefined })]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].message, "No time slots provided.");
  });

  it("single valid entry -> one successful item, exact shape", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([entry()]);
    assert.equal(result.successful.length, 1);
    assert.equal(result.successful[0].assignedSlotId, "1");
    assert.equal(result.successful[0].courseId, COURSE);
  });

  it("slot-ID incrementing: multiple slots in one entry get consecutive IDs, one stored schedule per slot", async () => {
    const { service, repository } = makeService();
    const result = await service.createSchedules([
      entry({
        timeSlots: [
          { startTime: "09:00", endTime: "10:00" },
          { startTime: "11:00", endTime: "12:00" },
        ],
      }),
    ]);
    assert.deepEqual(
      result.successful.map((s) => s.assignedSlotId),
      ["1", "2"]
    );
    assert.equal(repository.records.length, 2);
  });

  it("an unexpected repository error propagates out of createSchedules (not swallowed into failedSchedules)", async () => {
    class ThrowingRepository extends FakeScheduleRepository {
      async insertSchedule(): Promise<void> {
        throw new Error("simulated unexpected failure");
      }
    }
    const service = new ScheduleService(new ThrowingRepository());
    await assert.rejects(() => service.createSchedules([entry()]), /simulated unexpected failure/);
  });

  it("failed-row fallback uses || not ?? -- a falsy-non-nullish courseId (0) still becomes ''", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([{ courseId: 0, startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(result.failed.length, 1);
    assert.strictEqual(result.failed[0].courseId, "");
  });

  it("allocator key is the storable (courseId, startDate, endDate, testType) tuple", async () => {
    let observedKey: SlotIdKey | undefined;
    class SpyRepository extends FakeScheduleRepository {
      async findMaxSlotId(key: SlotIdKey): Promise<number> {
        observedKey = key;
        return super.findMaxSlotId(key);
      }
    }
    const service = new ScheduleService(new SpyRepository());
    await service.createSchedules([entry({ courseId: COURSE.toUpperCase() })]);
    assert.deepEqual(observedKey, { courseId: COURSE, startDate: "2026-10-05", endDate: "2026-10-05", testType: "Computer-Based" });
  });

  it("an empty/absent timeSlots entry fails with the legacy message without touching the allocator", async () => {
    class ThrowingMaxSlotRepository extends FakeScheduleRepository {
      async findMaxSlotId(): Promise<number> {
        throw new Error("simulated max-slot-ID query failure");
      }
    }
    const service = new ScheduleService(new ThrowingMaxSlotRepository());
    const result = await service.createSchedules([entry({ timeSlots: [] })]);
    assert.equal(result.failed[0].message, "No time slots provided.");
  });

  it("a throwing allocator read surfaces for an otherwise storable entry", async () => {
    class ThrowingMaxSlotRepository extends FakeScheduleRepository {
      async findMaxSlotId(): Promise<number> {
        throw new Error("simulated max-slot-ID query failure");
      }
    }
    const service = new ScheduleService(new ThrowingMaxSlotRepository());
    await assert.rejects(() => service.createSchedules([entry()]), /simulated max-slot-ID query failure/);
  });

  it("KNOWN CONCURRENCY DEFECT -- legacy-compatible allocator is not atomic across concurrent requests (characterization, not a guarantee)", async () => {
    // Two independent createSchedules() calls for the SAME key both read
    // max=0 before either insert completes and allocate the SAME slotId.
    // The legacy race is reproduced, not fixed (D-029: fix UNASSIGNED).
    const { service } = makeService();
    const [a, b] = await Promise.all([service.createSchedules([entry()]), service.createSchedules([entry()])]);
    assert.equal(a.successful[0].assignedSlotId, "1");
    assert.equal(b.successful[0].assignedSlotId, "1");
  });
});

describe("ScheduleService.createSchedules -- Stage 15 storability (intentional difference vs Mongo)", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["non-ObjectId courseId", { courseId: "c1" }, "courseId must be a valid course id"],
    ["impossible calendar date", { startDate: "2026-02-31", endDate: "2026-02-31" }, "startDate and endDate must be YYYY-MM-DD calendar dates"],
    ["non-date string", { startDate: "tomorrow" }, "startDate and endDate must be YYYY-MM-DD calendar dates"],
    ["missing testType (Mongo stored '')", { testType: undefined }, "testType must be Computer-Based or Paper-Based"],
    ["unknown testType", { testType: "Oral" }, "testType must be Computer-Based or Paper-Based"],
    ["unknown status", { status: "Draft" }, "status must be Scheduled or Cancelled"],
    ["non-text name", { name: 5 }, "name and testSystem must be text"],
    ["NUL in name", { name: "a\u0000b" }, "name and testSystem must not contain NUL characters"],
    ["fractional seats", { timeSlots: [{ startTime: "09:00", endTime: "10:00", slot: 1.5 }] }, "slot and totalSlot must be whole numbers"],
    ["seat count beyond 32-bit", { timeSlots: [{ startTime: "09:00", endTime: "10:00", slot: 3000000000 }] }, "slot and totalSlot must be whole numbers"],
  ];
  for (const [label, overrides, message] of cases) {
    it(`rejects ${label} per entry with a fixed message, persisting nothing`, async () => {
      const { service, repository } = makeService();
      const result = await service.createSchedules([entry(overrides)]);
      assert.equal(result.successful.length, 0);
      assert.equal(result.failed[0].message, message);
      assert.equal(repository.records.length, 0);
    });
  }

  it("a storable entry after a rejected one still succeeds (per-entry isolation)", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([entry({ testType: "Oral" }), entry()]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.successful.length, 1);
  });

  it("mixed-case courseId is canonicalized to lowercase hex before storage and echoed as sent", async () => {
    const { service, repository } = makeService();
    const result = await service.createSchedules([entry({ courseId: COURSE.toUpperCase() })]);
    assert.equal(repository.records[0].courseId, COURSE);
    assert.equal(result.successful[0].courseId, COURSE.toUpperCase());
  });
});

describe("ScheduleService.getByDateAndCourse", () => {
  it("returns mapped records for the exact course+date match", async () => {
    const doc = scheduleRecord();
    const { service } = makeService([doc]);
    const result = await service.getByDateAndCourse("2026-10-05", doc.courseId as string);
    assert.equal(result.length, 1);
  });
});

describe("ScheduleService.getByCourseAndMonth -- month-range calculation consumer", () => {
  it("filters by the given string month range", async () => {
    const courseId = newObjectIdHex();
    const inRange = scheduleRecord({ courseId, startDate: "2026-10-15" });
    const outOfRange = scheduleRecord({ courseId, startDate: "2026-11-01" });
    const { service } = makeService([inRange, outOfRange]);
    const result = await service.getByCourseAndMonth(courseId, { startInclusive: "2026-10-01", endExclusive: "2026-11-01" });
    assert.equal(result.length, 1);
    assert.equal(result[0]._id, inRange._id);
  });
});

describe("ScheduleService.listAdmin -- pagination clamp normalization consumer", () => {
  it("returns {schedules,total,page,limit}", async () => {
    const { service } = makeService([scheduleRecord(), scheduleRecord(), scheduleRecord()]);
    const result = await service.listAdmin({}, { page: 1, limit: 100, skip: 0 });
    assert.equal(result.total, 3);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 100);
    assert.equal(result.schedules.length, 3);
  });

  it("propagates ScheduleQueryTimeoutError from either concurrent query", async () => {
    const service = new ScheduleService(new TimeoutScheduleRepository());
    await assert.rejects(() => service.listAdmin({}, { page: 1, limit: 100, skip: 0 }), { name: "ScheduleQueryTimeoutError" });
  });
});

describe("ScheduleService.deleteById -- delete result mapping", () => {
  it("returns true when a document was deleted", async () => {
    const doc = scheduleRecord();
    const { service } = makeService([doc]);
    assert.equal(await service.deleteById(doc._id as string), true);
  });

  it("returns false when no document matched", async () => {
    const { service } = makeService();
    assert.equal(await service.deleteById(newObjectIdHex()), false);
  });
});
