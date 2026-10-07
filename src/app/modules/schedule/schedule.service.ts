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

export class ScheduleService {
  constructor(private readonly repository: ScheduleRepository) {}

  // Unexpected persistence errors must propagate for a 500; swallowing them
  // into failedSchedules[] would wrongly yield 207/201.
  // Slot-ID allocator (read max, then insert) is reproduced as-is, not fixed.
  async createSchedules(entries: CreateScheduleEntryInput[]): Promise<CreateScheduleBatchResult> {
    const successful: CreateScheduleBatchResult["successful"] = [];
    const failed: CreateScheduleBatchResult["failed"] = [];
    const nowIso = new Date().toISOString();

    for (const raw of entries) {
      const { courseId, startDate, endDate } = (raw ?? {}) as Record<string, unknown>;
      const parsed = parseCreateScheduleEntry(raw);

      if (!parsed) {
        failed.push({
          courseId: (courseId as unknown) || "",
          startDate: (startDate as unknown) || "",
          endDate: (endDate as unknown) || "",
          message: "Missing courseId/startDate/endDate",
          timestamp: nowIso,
        });
        continue;
      }

      // Read max slot ID before normalizing/checking timeSlots, matching legacy order.
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

  async listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<AdminListResult> {
    const [docs, total] = await Promise.all([this.repository.listAdmin(filter, params), this.repository.countAdmin(filter)]);
    return { schedules: toScheduleDtoList(docs), total, page: params.page, limit: params.limit };
  }

  async deleteById(id: string): Promise<boolean> {
    return this.repository.deleteById(id);
  }

  async getByUserId(userId: string): Promise<ScheduleRecord[]> {
    const docs = await this.repository.findByUserId(userId);
    return toScheduleDtoList(docs);
  }
}
