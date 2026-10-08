// Test-only in-memory stand-ins for the Stage 15 PostgreSQL repositories.
//
// These exercise everything ABOVE the repository boundary (routes,
// middleware, controllers, services, authorization) without a database. They
// are NOT evidence of PostgreSQL behavior: that is proven separately against
// the real stage13-dev database (tests/postgres/*.postgres.ts) and against a
// real ephemeral MongoDB reference (tests/parity/*.parity.ts).

import type { BookingRepository } from "../../src/app/modules/booking/booking.repository";
import type { CoreRepositories } from "../../src/app/runtime/core-repositories";
import type { AuthRepository } from "../../src/app/modules/auth/auth.repository";
import type { UserRepository } from "../../src/app/modules/user/user.repository";
import type { CourseRepository } from "../../src/app/modules/course/course.repository";
import type { CourseRecord } from "../../src/app/modules/course/course.types";
import type { ScheduleRepository } from "../../src/app/modules/schedule/schedule.repository";
import { ScheduleQueryTimeoutError } from "../../src/app/modules/schedule/schedule.types";
import type {
  AdminListFilter,
  AdminListParams,
  MonthRange,
  NewScheduleRecord,
  ScheduleRecord,
  SlotIdKey,
} from "../../src/app/modules/schedule/schedule.types";
import { newObjectIdHex } from "../../src/app/shared/utils/object-id";

export function throwingRepository<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop: string | symbol) {
      if (prop === "then") return undefined;
      throw new Error(`Unexpected persistence access in test (${name}.${String(prop)})`);
    },
  });
}

export class FakeCourseRepository implements CourseRepository {
  constructor(private readonly records: CourseRecord[] = []) {}
  async findAll(): Promise<CourseRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
}

// Models what the Stage 14 ETL would have loaded into PostgreSQL for a Mongo
// course document: modeled columns only, homeBasedSystems defaulted to [].
export function courseRecordFromMongoDoc(doc: Record<string, unknown>): CourseRecord {
  const record: CourseRecord = {
    _id: String(doc._id),
    name: doc.name as string,
    image: doc.image as string,
    homeBasedSystems: Array.isArray(doc.homeBasedSystems) ? (doc.homeBasedSystems as string[]) : [],
  };
  if (doc.createdAt instanceof Date) record.createdAt = doc.createdAt;
  if (doc.updatedAt instanceof Date) record.updatedAt = doc.updatedAt;
  return record;
}

// In-memory Schedule repository with the same observable semantics as
// PrismaScheduleRepository (Cancelled exclusion, numeric first-slot ordering,
// _id-desc admin listing, unmatched filters => nothing, findByUserId => []).
export class FakeScheduleRepository implements ScheduleRepository {
  readonly inserted: NewScheduleRecord[] = [];
  constructor(public records: ScheduleRecord[] = []) {}

  private slotNumber(record: ScheduleRecord): number {
    const first = (record.timeSlots?.[0] as { slotId?: unknown } | undefined)?.slotId;
    const n = typeof first === "string" && /^\d+$/.test(first) ? Number(first) : 0;
    return n;
  }

  async findMaxSlotId(key: SlotIdKey): Promise<number> {
    let max = 0;
    for (const r of this.records) {
      if (r.courseId !== key.courseId || r.startDate !== key.startDate || r.endDate !== key.endDate || r.testType !== key.testType) continue;
      for (const slot of (r.timeSlots ?? []) as Array<{ slotId?: unknown }>) {
        const n = typeof slot.slotId === "string" && /^\d{1,9}$/.test(slot.slotId) ? Number(slot.slotId) : 0;
        if (n > max) max = n;
      }
    }
    return max;
  }

  async insertSchedule(doc: NewScheduleRecord): Promise<void> {
    this.inserted.push(doc);
    this.records.push({
      _id: newObjectIdHex(),
      courseId: doc.courseId,
      startDate: doc.startDate,
      endDate: doc.endDate,
      name: doc.name,
      testSystem: doc.testSystem,
      testType: doc.testType,
      status: doc.status,
      timeSlots: doc.timeSlots.map((s) => ({ ...s })),
      createdAt: doc.createdAt,
    });
  }

  async findByDateAndCourse(date: string, courseId: string): Promise<ScheduleRecord[]> {
    return this.records
      .filter((r) => r.courseId === courseId && r.startDate === date && r.endDate === date && r.status !== "Cancelled")
      .sort(
        (a, b) =>
          this.slotNumber(a) - this.slotNumber(b) ||
          String(a.startDate).localeCompare(String(b.startDate)) ||
          String(a._id).localeCompare(String(b._id))
      )
      .map((r) => ({ ...r }));
  }

  async findByCourseAndMonth(courseId: string, range: MonthRange): Promise<ScheduleRecord[]> {
    return this.records
      .filter(
        (r) =>
          r.courseId === courseId &&
          String(r.startDate) >= range.startInclusive &&
          String(r.startDate) < range.endExclusive &&
          r.status !== "Cancelled"
      )
      .sort((a, b) => String(a._id).localeCompare(String(b._id)))
      .map((r) => ({ ...r }));
  }

  private filtered(filter: AdminListFilter): ScheduleRecord[] {
    return this.records.filter(
      (r) => (filter.courseId === undefined || r.courseId === filter.courseId) && (filter.status === undefined || r.status === filter.status)
    );
  }

  async listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<ScheduleRecord[]> {
    return this.filtered(filter)
      .sort((a, b) => String(b._id).localeCompare(String(a._id)))
      .slice(params.skip, params.skip + params.limit)
      .map((r) => ({ ...r }));
  }

  async countAdmin(filter: AdminListFilter): Promise<number> {
    return this.filtered(filter).length;
  }

  async deleteById(id: string): Promise<boolean> {
    const index = this.records.findIndex((r) => r._id === id);
    if (index === -1) return false;
    this.records.splice(index, 1);
    return true;
  }

  async findByUserId(_userId: string): Promise<ScheduleRecord[]> {
    return [];
  }
}

export class TimeoutScheduleRepository extends FakeScheduleRepository {
  async listAdmin(): Promise<never> {
    throw new ScheduleQueryTimeoutError();
  }
}

// Fixture builder: canonical PostgreSQL-shaped schedule record.
export function scheduleRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    _id: newObjectIdHex(),
    courseId: newObjectIdHex(),
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    name: "IELTS",
    testSystem: "",
    testType: "Computer-Based",
    status: "Scheduled",
    timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 10, slotId: "1" }],
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

// Models what the Stage 14 ETL would have loaded into PostgreSQL for a Mongo
// schedule document that has exactly the modeled fields.
export function scheduleRecordFromMongoDoc(doc: Record<string, unknown>): ScheduleRecord {
  const record: ScheduleRecord = {
    _id: String(doc._id),
    courseId: doc.courseId as string,
    startDate: doc.startDate as string,
    endDate: doc.endDate as string,
    name: doc.name as string,
  };
  if (typeof doc.testSystem === "string") record.testSystem = doc.testSystem;
  record.testType = doc.testType as string;
  record.status = doc.status as string;
  record.timeSlots = ((doc.timeSlots as Array<Record<string, unknown>> | undefined) ?? []).map((s) => ({
    startTime: s.startTime,
    endTime: s.endTime,
    slot: s.slot,
    totalSlot: s.totalSlot,
    slotId: String(s.slotId),
  }));
  record.createdAt = doc.createdAt instanceof Date ? doc.createdAt : new Date(String(doc.createdAt));
  return record;
}

export function fakeCoreRepositories(overrides: Partial<CoreRepositories> = {}): CoreRepositories {
  return {
    auth: throwingRepository<AuthRepository>("auth"),
    user: throwingRepository<UserRepository>("user"),
    course: throwingRepository<CourseRepository>("course"),
    schedule: throwingRepository<ScheduleRepository>("schedule"),
    booking: throwingRepository<BookingRepository>("booking"),
    ...overrides,
  };
}
