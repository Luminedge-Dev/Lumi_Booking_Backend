import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../database/prisma";
import { isStatementTimeout, PersistenceError, runPersistence } from "../../database/persistence-error";
import { runWithStatementTimeout } from "../../database/transaction";
import { newObjectIdHex, toCanonicalObjectIdHex } from "../../shared/utils/object-id";
import { ScheduleQueryTimeoutError } from "./schedule.types";
import { parseCalendarDate, isRealCalendarDate } from "./schedule.validation";
import type {
  AdminListFilter,
  AdminListParams,
  MonthRange,
  NewScheduleRecord,
  ScheduleRecord,
  SlotIdKey,
} from "./schedule.types";

// Persistence port. Services depend on this interface only.
export interface ScheduleRepository {
  findMaxSlotId(key: SlotIdKey): Promise<number>;
  insertSchedule(doc: NewScheduleRecord): Promise<void>;
  findByDateAndCourse(date: string, courseId: string): Promise<ScheduleRecord[]>;
  findByCourseAndMonth(courseId: string, range: MonthRange): Promise<ScheduleRecord[]>;
  listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<ScheduleRecord[]>;
  countAdmin(filter: AdminListFilter): Promise<number>;
  deleteById(id: string): Promise<boolean>;
  findByUserId(userId: string): Promise<ScheduleRecord[]>;
}

const TEST_TYPE_TO_WIRE = { ComputerBased: "Computer-Based", PaperBased: "Paper-Based" } as const;
const TEST_TYPE_FROM_WIRE = { "Computer-Based": "ComputerBased", "Paper-Based": "PaperBased" } as const;

type ScheduleRow = {
  id: string;
  name: string;
  courseId: string;
  startDate: Date;
  endDate: Date;
  testType: keyof typeof TEST_TYPE_TO_WIRE;
  testSystem: string | null;
  status: "Scheduled" | "Cancelled";
  createdAt: Date;
};
type SlotRow = {
  scheduleId: string;
  position: number;
  slotId: string;
  seatsLeft: number;
  capacityTotal: number;
  startTime: string;
  endTime: string;
};

// A statement timeout stays a Schedule-domain error so the controller keeps
// owning the existing 504 mapping; every other persistence error propagates.
async function withTimeoutMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error instanceof PersistenceError && error.kind === "TIMEOUT") || isStatementTimeout(error)) {
      throw new ScheduleQueryTimeoutError();
    }
    throw error;
  }
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toRecord(row: ScheduleRow, slots: SlotRow[]): ScheduleRecord {
  const record: ScheduleRecord = {
    _id: row.id,
    courseId: row.courseId,
    startDate: dateOnly(row.startDate),
    endDate: dateOnly(row.endDate),
    name: row.name,
  };
  if (row.testSystem !== null) record.testSystem = row.testSystem;
  record.testType = TEST_TYPE_TO_WIRE[row.testType];
  record.status = row.status;
  record.timeSlots = slots.map((slot) => ({
    startTime: slot.startTime,
    endTime: slot.endTime,
    slot: slot.seatsLeft,
    totalSlot: slot.capacityTotal,
    slotId: slot.slotId,
  }));
  record.createdAt = row.createdAt;
  return record;
}

function numericSlotId(slots: SlotRow[]): number {
  const first = slots[0]?.slotId;
  if (first === undefined || !/^\d+$/.test(first)) return 0;
  const n = Number(first);
  return Number.isSafeInteger(n) ? n : 0;
}

export class PrismaScheduleRepository implements ScheduleRepository {
  constructor(
    private readonly getClient: () => PrismaClient = getPrismaClient,
    private readonly timeouts: { listMs: number; countMs: number } = { listMs: 8000, countMs: 3000 }
  ) {}

  private async hydrate(
    client: Pick<PrismaClient, "scheduleSlot">,
    rows: ScheduleRow[]
  ): Promise<Map<string, SlotRow[]>> {
    const bySchedule = new Map<string, SlotRow[]>();
    if (rows.length === 0) return bySchedule;
    const slots = await client.scheduleSlot.findMany({
      where: { scheduleId: { in: rows.map((row) => row.id) } },
      orderBy: [{ scheduleId: "asc" }, { position: "asc" }],
    });
    for (const slot of slots) {
      const list = bySchedule.get(slot.scheduleId) ?? [];
      list.push(slot);
      bySchedule.set(slot.scheduleId, list);
    }
    return bySchedule;
  }

  // Legacy allocator parity: highest slotId among schedules sharing the
  // (courseId, startDate, endDate, testType) key. Deliberately NOT atomic with
  // the insert that follows (known, characterized legacy race; unfixed).
  async findMaxSlotId(key: SlotIdKey): Promise<number> {
    return runPersistence({ table: "schedule_slots", operation: "schedule.max_slot_id" }, async () => {
      const rows = await this.getClient().$queryRaw<Array<{ max_id: number | null }>>`
        SELECT MAX(CAST(ss.slot_id AS INTEGER)) AS max_id
        FROM schedule_slots ss
        JOIN schedules s ON s.id = ss.schedule_id
        WHERE s.course_id = ${key.courseId}
          AND s.start_date = ${parseCalendarDate(key.startDate)}::date
          AND s.end_date = ${parseCalendarDate(key.endDate)}::date
          AND s.test_type = ${key.testType}::"TestType"
          AND ss.slot_id ~ '^[0-9]{1,9}$'`;
      return Number(rows[0]?.max_id ?? 0);
    });
  }

  // One schedule + its slots + its counter seed commit together (single
  // PostgreSQL transaction; nothing here spans Mongo).
  async insertSchedule(doc: NewScheduleRecord): Promise<void> {
    await runPersistence({ table: "schedules", operation: "schedule.insert" }, async () => {
      const client = this.getClient();
      const id = newObjectIdHex();
      const maxSlot = doc.timeSlots.reduce((max, slot) => Math.max(max, Number(slot.slotId)), 0);
      await client.$transaction([
        client.schedule.create({
          data: {
            id,
            name: doc.name,
            courseId: doc.courseId,
            startDate: parseCalendarDate(doc.startDate),
            endDate: parseCalendarDate(doc.endDate),
            testType: TEST_TYPE_FROM_WIRE[doc.testType],
            testSystem: doc.testSystem,
            status: doc.status,
            createdAt: doc.createdAt,
          },
        }),
        client.scheduleSlot.createMany({
          data: doc.timeSlots.map((slot, position) => ({
            scheduleId: id,
            position,
            slotId: slot.slotId,
            seatsLeft: slot.slot,
            capacityTotal: slot.totalSlot,
            startTime: slot.startTime,
            endTime: slot.endTime,
          })),
        }),
        client.slotCounter.create({ data: { scheduleId: id, nextN: maxSlot + 1 } }),
      ]);
    });
  }

  async findByDateAndCourse(date: string, courseId: string): Promise<ScheduleRecord[]> {
    // Stored values are always canonical ids / real dates, so anything else matches nothing.
    const canonicalCourseId = toCanonicalObjectIdHex(courseId);
    if (!canonicalCourseId || !isRealCalendarDate(date)) return [];
    return runPersistence({ table: "schedules", operation: "schedule.find_by_date_course" }, async () => {
      const client = this.getClient();
      const day = parseCalendarDate(date);
      const rows = await client.schedule.findMany({
        where: { courseId: canonicalCourseId, startDate: day, endDate: day, status: { not: "Cancelled" } },
      });
      const slots = await this.hydrate(client, rows);
      const records = rows.map((row) => ({ row, slots: slots.get(row.id) ?? [] }));
      // Legacy order: first slot id numerically, then startDate, then _id.
      records.sort(
        (a, b) =>
          numericSlotId(a.slots) - numericSlotId(b.slots) ||
          a.row.startDate.getTime() - b.row.startDate.getTime() ||
          (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
      );
      return records.map(({ row, slots: s }) => toRecord(row, s));
    });
  }

  async findByCourseAndMonth(courseId: string, range: MonthRange): Promise<ScheduleRecord[]> {
    const canonicalCourseId = toCanonicalObjectIdHex(courseId);
    if (!canonicalCourseId) return [];
    return runPersistence({ table: "schedules", operation: "schedule.find_by_course_month" }, async () => {
      const client = this.getClient();
      const rows = await client.schedule.findMany({
        where: {
          courseId: canonicalCourseId,
          startDate: { gte: parseCalendarDate(range.startInclusive), lt: parseCalendarDate(range.endExclusive) },
          status: { not: "Cancelled" },
        },
        orderBy: { id: "asc" },
      });
      const slots = await this.hydrate(client, rows);
      return rows.map((row) => toRecord(row, slots.get(row.id) ?? []));
    });
  }

  // Filter values that cannot exist in PostgreSQL (non-id courseId, status
  // outside the enum) match nothing, exactly like an exact-match Mongo query.
  private buildWhere(filter: AdminListFilter): { where: Record<string, unknown> } | null {
    const where: Record<string, unknown> = {};
    if (filter.courseId !== undefined) {
      const courseId = toCanonicalObjectIdHex(filter.courseId);
      if (!courseId) return null;
      where.courseId = courseId;
    }
    if (filter.status !== undefined) {
      if (filter.status !== "Scheduled" && filter.status !== "Cancelled") return null;
      where.status = filter.status;
    }
    return { where };
  }

  async listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<ScheduleRecord[]> {
    const built = this.buildWhere(filter);
    if (!built) return [];
    return withTimeoutMapping(() =>
      runPersistence({ table: "schedules", operation: "schedule.list_admin" }, async () =>
        runWithStatementTimeout(this.getClient(), this.timeouts.listMs, async (tx) => {
          const rows = await tx.schedule.findMany({
            where: built.where,
            orderBy: { id: "desc" },
            skip: params.skip,
            take: params.limit,
          });
          const slots = await this.hydrate(tx, rows);
          return rows.map((row) => toRecord(row, slots.get(row.id) ?? []));
        })
      )
    );
  }

  async countAdmin(filter: AdminListFilter): Promise<number> {
    const built = this.buildWhere(filter);
    if (!built) return 0;
    return withTimeoutMapping(() =>
      runPersistence({ table: "schedules", operation: "schedule.count_admin" }, async () =>
        runWithStatementTimeout(this.getClient(), this.timeouts.countMs, (tx) => tx.schedule.count({ where: built.where }))
      )
    );
  }

  // Hard delete, no booking check (D-029/D-012). Children have no FK, so they
  // are removed in the same transaction to avoid orphan rows.
  async deleteById(id: string): Promise<boolean> {
    const canonicalId = toCanonicalObjectIdHex(id);
    if (!canonicalId) return false;
    return runPersistence({ table: "schedules", operation: "schedule.delete" }, async () => {
      const client = this.getClient();
      const [deleted] = await client.$transaction([
        client.schedule.deleteMany({ where: { id: canonicalId } }),
        client.scheduleSlot.deleteMany({ where: { scheduleId: canonicalId } }),
        client.slotCounter.deleteMany({ where: { scheduleId: canonicalId } }),
      ]);
      return deleted.count > 0;
    });
  }

  // PostgreSQL has no schedule.userId column (Stage 14: only 3 quarantined
  // legacy documents ever carried one), so no schedule can match.
  async findByUserId(_userId: string): Promise<ScheduleRecord[]> {
    return [];
  }
}
