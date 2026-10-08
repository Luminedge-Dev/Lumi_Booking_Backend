import type { PrismaClient } from "../../../src/generated/prisma/client.js";
import { assertStage13Target } from "./stage13-target";

// Stage 16 fixture ownership for stage13-dev tests.
//
// Ids for users / schedules / slots / bookings use one reserved ObjectId-valid
// prefix. 0xffff5166 is a timestamp in year 2106, so a real Mongo-derived id
// can never carry it. TeacherAssignment ids are deterministic UUIDv5 values and
// can never match that pattern, so their ownership is proven through the
// fixture user they belong to instead of through the id itself.
export const STAGE16_PREFIX = "ffff5166";
export const STAGE16B_PREFIX = "ffff16b0";
export const STAGE16_ID_PATTERN = /^ffff5166[0-9a-f]{16}$/;
export const STAGE16_EMAIL_DOMAIN = "stage16-test.example.invalid";
export const STAGE16B_EMAIL_DOMAIN = "stage16b-test.example.invalid";

export function prefixedId(prefix: string, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("fixture counter out of range");
  return prefix + n.toString(16).padStart(16, "0");
}

export function stage16Id(n: number): string {
  return prefixedId(STAGE16_PREFIX, n);
}

export function isOwnedId(value: string, prefix = STAGE16_PREFIX): boolean {
  return new RegExp(`^${prefix}[0-9a-f]{16}$`).test(value);
}

type Model = {
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  findMany: (args: { where: Record<string, unknown> }) => Promise<Array<Record<string, unknown>>>;
};

function model(prisma: PrismaClient, name: string): Model {
  return (prisma as unknown as Record<string, Model>)[name]!;
}

// Every table that can carry a Stage 16 fixture, with the column that proves
// ownership and the delete filter that is allowed to run.
const OWNERSHIP: Array<{ model: string; table: string; ownerColumn: "id" | "userId" | "scheduleId" }> = [
  { model: "teacherAssignment", table: "teacher_assignments", ownerColumn: "userId" },
  { model: "booking", table: "bookings", ownerColumn: "id" },
  { model: "mockAllocation", table: "mock_allocations", ownerColumn: "userId" },
  { model: "scheduleSlot", table: "schedule_slots", ownerColumn: "scheduleId" },
  { model: "slotCounter", table: "slot_counters", ownerColumn: "scheduleId" },
  { model: "schedule", table: "schedules", ownerColumn: "id" },
  { model: "user", table: "users", ownerColumn: "id" },
];

// Tracks the ids a test created. Cleanup deletes ONLY tracked, prefix-verified
// ids (never a LIKE sweep), and re-verifies every row it is about to remove.
export class Stage16Fixtures {
  readonly userIds = new Set<string>();
  readonly scheduleIds = new Set<string>();
  readonly bookingIds = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly prefix = STAGE16_PREFIX
  ) {
    assertStage13Target();
  }

  trackUser(id: string): string {
    this.assertOwned(id);
    this.userIds.add(id);
    return id;
  }
  trackSchedule(id: string): string {
    this.assertOwned(id);
    this.scheduleIds.add(id);
    return id;
  }
  trackBooking(id: string): string {
    this.assertOwned(id);
    this.bookingIds.add(id);
    return id;
  }

  private assertOwned(id: string): void {
    if (!isOwnedId(id, this.prefix)) throw new Error(`STOP: ${id} is outside the ${this.prefix} fixture namespace`);
  }

  // Namespace must be empty before a run starts and after cleanup finishes.
  async countNamespace(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const like = `${this.prefix}%`;
    for (const { table, ownerColumn } of OWNERSHIP) {
      const column = { id: "id", userId: "user_id", scheduleId: "schedule_id" }[ownerColumn];
      const rows = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} LIKE $1`,
        like
      );
      counts[table] = rows[0]?.n ?? 0;
    }
    // Bookings can also reference a fixture user/schedule with a non-fixture id.
    const refs = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE user_id LIKE $1 OR schedule_id LIKE $1`,
      like
    );
    counts["bookings_by_ref"] = refs[0]?.n ?? 0;
    return counts;
  }

  async assertNamespaceEmpty(label: string): Promise<void> {
    const counts = await this.countNamespace();
    const dirty = Object.entries(counts).filter(([, n]) => n > 0);
    if (dirty.length > 0) {
      throw new Error(`STOP (${label}): Stage 16 fixture namespace is not empty: ${JSON.stringify(Object.fromEntries(dirty))}`);
    }
  }

  async cleanup(): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    const users = [...this.userIds];
    const schedules = [...this.scheduleIds];
    const bookings = [...this.bookingIds];
    [...users, ...schedules, ...bookings].forEach((id) => this.assertOwned(id));

    const filters: Record<string, Record<string, unknown> | null> = {
      // Assignment rows: owned only if the row's user is a tracked fixture user.
      teacherAssignment: users.length ? { userId: { in: users } } : null,
      booking: bookings.length || users.length
        ? { OR: [{ id: { in: bookings } }, { userId: { in: users } }, { scheduleId: { in: schedules } }] }
        : null,
      mockAllocation: users.length ? { userId: { in: users } } : null,
      scheduleSlot: schedules.length ? { scheduleId: { in: schedules } } : null,
      slotCounter: schedules.length ? { scheduleId: { in: schedules } } : null,
      schedule: schedules.length ? { id: { in: schedules } } : null,
      user: users.length ? { id: { in: users } } : null,
    };

    for (const entry of OWNERSHIP) {
      const where = filters[entry.model];
      if (!where) continue;
      // Re-verify ownership of every row that matches before deleting it.
      const rows = await model(this.prisma, entry.model).findMany({ where });
      for (const row of rows) {
        const owner = String(row[entry.ownerColumn]);
        if (entry.model === "booking") {
          const ok = isOwnedId(String(row.id), this.prefix) || users.includes(String(row.userId));
          if (!ok) throw new Error(`STOP: refusing to delete non-fixture booking row`);
        } else if (!isOwnedId(owner, this.prefix)) {
          throw new Error(`STOP: refusing to delete non-fixture row in ${entry.table}`);
        }
      }
      const result = await model(this.prisma, entry.model).deleteMany({ where });
      removed[entry.table] = result.count;
    }
    return removed;
  }
}
