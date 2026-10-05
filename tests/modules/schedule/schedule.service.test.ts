import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";
import { ScheduleRepository } from "../../../src/app/modules/schedule/schedule.repository";
import { ScheduleService } from "../../../src/app/modules/schedule/schedule.service";
import { ScheduleQueryTimeoutError, type SlotIdKey } from "../../../src/app/modules/schedule/schedule.types";
import { FakeSchedulesCollection, type FakeScheduleDoc } from "../../helpers/fake-schedules-collection";

function makeService(docs: FakeScheduleDoc[] = []): { service: ScheduleService; schedules: FakeSchedulesCollection } {
  const schedules = new FakeSchedulesCollection(docs);
  const repository = new ScheduleRepository(schedules as unknown as Collection<Document>);
  return { service: new ScheduleService(repository), schedules };
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
    const result = await service.createSchedules([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].message, "No time slots provided.");
  });

  it("single valid entry -> one successful item, exact shape", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([
      { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
    ]);
    assert.equal(result.successful.length, 1);
    assert.equal(result.successful[0].assignedSlotId, "1");
    assert.equal(result.successful[0].courseId, "c1");
  });

  it("slot-ID incrementing against a fake repository: multiple slots in one entry get consecutive IDs", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([
      {
        courseId: "c1",
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        timeSlots: [
          { startTime: "09:00", endTime: "10:00" },
          { startTime: "11:00", endTime: "12:00" },
        ],
      },
    ]);
    assert.deepEqual(
      result.successful.map((s) => s.assignedSlotId),
      ["1", "2"]
    );
  });

  it("an unexpected repository error propagates out of createSchedules (does not get swallowed into failedSchedules)", async () => {
    class ThrowingRepository extends ScheduleRepository {
      async insertSchedule(): Promise<void> {
        throw new Error("simulated unexpected failure");
      }
    }
    const repository = new ThrowingRepository(new FakeSchedulesCollection() as unknown as Collection<Document>);
    const service = new ScheduleService(repository);
    await assert.rejects(
      () =>
        service.createSchedules([
          { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
        ]),
      /simulated unexpected failure/
    );
  });

  it("CLOSURE PATCH: failed-row fallback uses || not ?? -- a falsy-non-nullish courseId (0) still becomes ''", async () => {
    const { service } = makeService();
    const result = await service.createSchedules([{ courseId: 0, startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(result.failed.length, 1);
    assert.strictEqual(result.failed[0].courseId, "");
  });

  it("CLOSURE PATCH: persisted doc defaults testType to '' while the max-slot lookup key stays raw (undefined)", async () => {
    const schedules = new FakeSchedulesCollection();
    let observedKey: SlotIdKey | undefined;
    class SpyRepository extends ScheduleRepository {
      async findMaxSlotId(key: SlotIdKey): Promise<number> {
        observedKey = key;
        return super.findMaxSlotId(key);
      }
    }
    const service = new ScheduleService(new SpyRepository(schedules as unknown as Collection<Document>));
    await service.createSchedules([
      { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
    ]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    assert.strictEqual(stored.testType, "");
    assert.strictEqual(observedKey?.testType, undefined);
  });

  it("CLOSURE PATCH: findMaxSlotId is called before timeSlot normalization -- a throwing max-slot read surfaces even when timeSlots is empty/absent", async () => {
    class ThrowingMaxSlotRepository extends ScheduleRepository {
      async findMaxSlotId(): Promise<number> {
        throw new Error("simulated max-slot-ID query failure");
      }
    }
    const repository = new ThrowingMaxSlotRepository(new FakeSchedulesCollection() as unknown as Collection<Document>);
    const service = new ScheduleService(repository);
    // Valid required fields, no timeSlots at all -- if normalization/empty-
    // check ran before the max-slot read, this would resolve to a
    // failed[] entry instead of propagating the repository's throw.
    await assert.rejects(
      () => service.createSchedules([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" }]),
      /simulated max-slot-ID query failure/
    );
  });

  it("KNOWN CONCURRENCY DEFECT -- legacy-compatible allocator is not atomic across concurrent requests (characterization, not a guarantee)", async () => {
    // Two independent createSchedules() calls for the SAME key, started
    // concurrently, both read the same max (0) before either insert
    // completes -- they can allocate the SAME next slotId. This proves the
    // real, pre-existing race is reproduced by the native implementation,
    // not newly introduced and not fixed. See D-029: fix UNASSIGNED pending
    // a future design decision; this test documents the defect, it does
    // not assert correctness.
    const { service } = makeService();
    const entry = (courseId: string) => [
      { courseId, startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
    ];
    const [a, b] = await Promise.all([service.createSchedules(entry("race-course")), service.createSchedules(entry("race-course"))]);
    // Both observed max=0 and both assigned slotId "1" -- the race.
    assert.equal(a.successful[0].assignedSlotId, "1");
    assert.equal(b.successful[0].assignedSlotId, "1");
  });
});

describe("ScheduleService.getByDateAndCourse", () => {
  it("returns mapped records for the exact course+date match", async () => {
    const doc: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "1" }],
    };
    const { service } = makeService([doc]);
    const result = await service.getByDateAndCourse("2026-10-05", "c1");
    assert.equal(result.length, 1);
  });
});

describe("ScheduleService.getByCourseAndMonth -- month-range calculation consumer", () => {
  it("filters by the given string month range", async () => {
    const inRange: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", startDate: "2026-10-15", status: "Scheduled" };
    const outOfRange: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", startDate: "2026-11-01", status: "Scheduled" };
    const { service } = makeService([inRange, outOfRange]);
    const result = await service.getByCourseAndMonth("c1", { startInclusive: "2026-10-01", endExclusive: "2026-11-01" });
    assert.equal(result.length, 1);
    assert.equal(result[0]._id?.toString(), inRange._id.toString());
  });
});

describe("ScheduleService.listAdmin -- pagination clamp normalization consumer", () => {
  it("returns {schedules,total,page,limit}", async () => {
    const docs = Array.from({ length: 3 }, () => ({ _id: new ObjectId(), courseId: "c1" }) as FakeScheduleDoc);
    const { service } = makeService(docs);
    const result = await service.listAdmin({}, { page: 1, limit: 100, skip: 0 });
    assert.equal(result.total, 3);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 100);
    assert.equal(result.schedules.length, 3);
  });

  it("propagates ScheduleQueryTimeoutError from either concurrent query", async () => {
    class TimeoutRepository extends ScheduleRepository {
      async listAdmin(): Promise<never> {
        throw new ScheduleQueryTimeoutError();
      }
    }
    const repository = new TimeoutRepository(new FakeSchedulesCollection() as unknown as Collection<Document>);
    const service = new ScheduleService(repository);
    await assert.rejects(() => service.listAdmin({}, { page: 1, limit: 100, skip: 0 }), ScheduleQueryTimeoutError);
  });
});

describe("ScheduleService.deleteById -- delete result mapping", () => {
  it("returns true when a document was deleted", async () => {
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1" };
    const { service } = makeService([doc]);
    assert.equal(await service.deleteById(doc._id.toString()), true);
  });

  it("returns false when no document matched", async () => {
    const { service } = makeService();
    assert.equal(await service.deleteById(new ObjectId().toString()), false);
  });
});
