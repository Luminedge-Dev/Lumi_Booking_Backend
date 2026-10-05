import type { ScheduleRepository } from "./schedule.repository";
import { normalizeIncomingSlot, parseCreateScheduleEntry } from "./schedule.validation";
import { toScheduleDtoList } from "./schedule.mapper";
import type {
  AdminListFilter,
  AdminListParams,
  AdminListResult,
  CreateScheduleBatchResult,
  CreateScheduleEntryInput,
  MonthRange,
  ScheduleRecord,
} from "./schedule.types";

// No Express req/res. Authorization is handled entirely by route-attached
// guards (plain verifyAdmin/verifyToken/verifyStaff -- no per-resource
// ownership policy exists for Schedule, unlike Stage 8's User module).
export class ScheduleService {
  constructor(private readonly repository: ScheduleRepository) {}

  // Reproduces routes/schedule.routes.js's exact partial-batch semantics:
  // required-field validation -> max-slot-ID lookup -> slot normalization
  // -> empty-slot check -> insert, continuing past EXPECTED validation failures (missing required field /
  // no timeSlots) but letting an UNEXPECTED persistence/runtime error
  // propagate out of this method entirely -- mirroring legacy's single
  // try/catch wrapping its whole loop (routes/schedule.routes.js:76-124).
  // schedule.controller.ts's own try/catch is what turns that propagated
  // error into the legacy 500 response; this method must NOT swallow it
  // into failedSchedules[], which would silently change a 500 into a
  // 207/201 -- a real compatibility bug a well-meaning implementation could
  // introduce by accident.
  //
  // The slot-ID allocator (read max, then insert, no transaction/lock) is
  // reproduced exactly, not fixed -- a known, characterized concurrency
  // defect (D-029), fix UNASSIGNED pending a future design decision.
  async createSchedules(entries: CreateScheduleEntryInput[]): Promise<CreateScheduleBatchResult> {
    const successful: CreateScheduleBatchResult["successful"] = [];
    const failed: CreateScheduleBatchResult["failed"] = [];
    const nowIso = new Date().toISOString();

    for (const raw of entries) {
      const { courseId, startDate, endDate } = (raw ?? {}) as Record<string, unknown>;
      const parsed = parseCreateScheduleEntry(raw);

      if (!parsed) {
        failed.push({
          // Legacy uses || here (routes/schedule.routes.js:80), not ?? --
          // a falsy-but-non-nullish value (e.g. courseId: 0) must still
          // fall back to "", matching legacy exactly.
          courseId: (courseId as unknown) || "",
          startDate: (startDate as unknown) || "",
          endDate: (endDate as unknown) || "",
          message: "Missing courseId/startDate/endDate",
          timestamp: nowIso,
        });
        continue;
      }

      // Legacy's operation order (routes/schedule.routes.js:84-94): read
      // the max-slot-ID from Mongo BEFORE normalizing/checking timeSlots.
      // This matters under failure: a DB error on the max-slot query must
      // surface as a 500 even when timeSlots is empty, not be preempted by
      // an early empty-timeSlots failed[] entry.
      const key = {
        courseId: parsed.courseId,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        testType: parsed.testType,
      };
      let nextId = await this.repository.findMaxSlotId(key);

      const incomingSlots = parsed.timeSlots.map(normalizeIncomingSlot);

      if (!incomingSlots.length) {
        failed.push({
          courseId: parsed.courseId,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          message: "No time slots provided.",
          timestamp: nowIso,
        });
        continue;
      }

      for (const slot of incomingSlots) {
        nextId += 1;
        const doc = {
          courseId: parsed.courseId,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          name: parsed.name,
          testSystem: parsed.testSystem,
          // Legacy persists testType ?? "" (routes/schedule.routes.js:102)
          // while the max-slot key above stays raw -- do not default
          // parsed.testType itself, only the persisted field.
          testType: parsed.testType ?? "",
          status: parsed.status,
          timeSlots: [{ ...slot, slotId: String(nextId) }],
          createdAt: nowIso,
        };
        await this.repository.insertSchedule(doc);
        successful.push({
          courseId: parsed.courseId,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          assignedSlotId: String(nextId),
          createdAt: nowIso,
        });
      }
    }

    return { successful, failed };
  }

  async getByDateAndCourse(date: string, courseId: string): Promise<ScheduleRecord[]> {
    const docs = await this.repository.findByDateAndCourse(date, courseId);
    return toScheduleDtoList(docs);
  }

  async getByCourseAndMonth(courseId: string, range: MonthRange): Promise<ScheduleRecord[]> {
    const docs = await this.repository.findByCourseAndMonth(courseId, range);
    return toScheduleDtoList(docs);
  }

  // Mirrors legacy's Promise.all([find, countDocuments]) concurrency shape
  // exactly -- either query can independently throw ScheduleQueryTimeoutError.
  async listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<AdminListResult> {
    const [docs, total] = await Promise.all([this.repository.listAdmin(filter, params), this.repository.countAdmin(filter)]);
    return { schedules: toScheduleDtoList(docs), total, page: params.page, limit: params.limit };
  }

  async deleteById(id: string): Promise<boolean> {
    return this.repository.deleteById(id);
  }
}
