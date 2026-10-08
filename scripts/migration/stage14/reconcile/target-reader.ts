// Stage 14 -- read-only view of the PostgreSQL target (stage13-dev) used by
// reconciliation. SELECT-only: findMany/count and fixed COUNT/SELECT templates.

import type { PrismaClient } from "../../../../src/generated/prisma/client.js";
import { TABLES, type TableName } from "../common";
import { rowDigest, TABLE_SPECS } from "../columns";
import type { VerifiedTarget } from "../guards";

const PAGE_SIZE = 2000;

type Pager = {
  findMany(args: {
    select: Record<string, true>;
    orderBy: Record<string, "asc">;
    take: number;
    cursor?: Record<string, string>;
    skip?: number;
  }): Promise<Array<Record<string, unknown>>>;
};

function pagerFor(prisma: PrismaClient, table: TableName): Pager {
  const map: Record<TableName, unknown> = {
    users: prisma.user,
    courses: prisma.course,
    schedules: prisma.schedule,
    schedule_slots: prisma.scheduleSlot,
    slot_counters: prisma.slotCounter,
    mock_allocations: prisma.mockAllocation,
    bookings: prisma.booking,
    teacher_assignments: prisma.teacherAssignment,
    feedback_entries: prisma.feedbackEntry,
    feedback_status: prisma.feedbackStatus,
    admin_sections: prisma.adminSection,
    trf_emails: prisma.trfEmail,
    trf_email_history: prisma.trfEmailHistory,
  };
  return map[table] as Pager;
}

/** Reads one table page by page (bounded memory) and digests every row. */
export async function readTableDigests(prisma: PrismaClient, _target: VerifiedTarget, table: TableName): Promise<Map<string, string>> {
  const spec = TABLE_SPECS[table];
  const select = Object.fromEntries(spec.columns.map((c) => [c, true as const]));
  const pager = pagerFor(prisma, table);
  const out = new Map<string, string>();
  let last: string | undefined;
  for (;;) {
    const rows = await pager.findMany({
      select,
      orderBy: { [spec.pk]: "asc" },
      take: PAGE_SIZE,
      ...(last !== undefined ? { cursor: { [spec.pk]: last }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) out.set(String(row[spec.pk]), rowDigest(table, row));
    last = String(rows[rows.length - 1]![spec.pk]);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

export async function readAllTableDigests(prisma: PrismaClient, target: VerifiedTarget): Promise<Record<TableName, Map<string, string>>> {
  const out = {} as Record<TableName, Map<string, string>>;
  for (const table of TABLES) out[table] = await readTableDigests(prisma, target, table);
  return out;
}

export interface TargetCheck {
  id: string;
  description: string;
  /** hard = any non-zero blocks the verdict. info = reported only. */
  severity: "hard" | "info";
  count: number;
}

// Fixed SQL constants only (no external input is ever interpolated), hence the Unsafe variant.
async function scalar(prisma: PrismaClient, sql: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(sql)) as Array<{ n: number | bigint }>;
  return Number(rows[0]?.n ?? 0);
}

/** SQL-side logical-orphan / duplicate-key / Better-Auth checks. Independent of the digest comparison. */
export async function runTargetChecks(prisma: PrismaClient, _target: VerifiedTarget): Promise<TargetCheck[]> {
  const checks: TargetCheck[] = [];
  const add = async (id: string, description: string, severity: "hard" | "info", sql: string): Promise<void> => {
    checks.push({ id, description, severity, count: await scalar(prisma, sql) });
  };

  await add("bookings_without_user", "bookings whose user_id has no users row", "hard",
    `SELECT COUNT(*)::int AS n FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id)`);
  await add("test_center_bookings_without_schedule", "Test Center bookings whose schedule_id has no schedules row", "hard",
    `SELECT COUNT(*)::int AS n FROM bookings b WHERE b.location::text = 'Test Center' AND (b.schedule_id IS NULL OR NOT EXISTS (SELECT 1 FROM schedules s WHERE s.id = b.schedule_id))`);
  await add("test_center_bookings_without_slot", "Test Center bookings whose (schedule_id, slot_id) has no schedule_slots row", "hard",
    `SELECT COUNT(*)::int AS n FROM bookings b WHERE b.location::text = 'Test Center' AND NOT EXISTS (SELECT 1 FROM schedule_slots s WHERE s.schedule_id = b.schedule_id AND s.slot_id = b.slot_id)`);
  await add("schedules_without_course", "schedules whose course_id has no courses row", "hard",
    `SELECT COUNT(*)::int AS n FROM schedules s WHERE NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = s.course_id)`);
  await add("slots_without_schedule", "schedule_slots whose schedule_id has no schedules row", "hard",
    `SELECT COUNT(*)::int AS n FROM schedule_slots s WHERE NOT EXISTS (SELECT 1 FROM schedules x WHERE x.id = s.schedule_id)`);
  await add("counters_without_schedule", "slot_counters whose schedule_id has no schedules row", "hard",
    `SELECT COUNT(*)::int AS n FROM slot_counters s WHERE NOT EXISTS (SELECT 1 FROM schedules x WHERE x.id = s.schedule_id)`);
  await add("duplicate_slot_keys", "(schedule_id, slot_id) pairs occurring more than once", "hard",
    `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM schedule_slots GROUP BY schedule_id, slot_id HAVING COUNT(*) > 1) d`);
  await add("slot_ids_shared_across_schedules", "slot_id values reused by more than one schedule (expected: slotId is scoped per schedule)", "info",
    `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM schedule_slots GROUP BY slot_id HAVING COUNT(DISTINCT schedule_id) > 1) d`);
  for (const table of ["mock_allocations", "teacher_assignments", "feedback_entries", "feedback_status", "admin_sections", "trf_emails", "trf_email_history"] as const) {
    await add(`${table}_without_user`, `${table} rows whose user_id has no users row`, "hard",
      `SELECT COUNT(*)::int AS n FROM ${table} c WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)`);
  }
  await add("teacher_assignments_both_refs", "teacher_assignments resolved to BOTH a booking and a schedule (must be XOR)", "hard",
    `SELECT COUNT(*)::int AS n FROM teacher_assignments WHERE booking_id IS NOT NULL AND schedule_id IS NOT NULL`);
  await add("teacher_assignments_no_ref", "teacher_assignments resolved to NEITHER a booking nor a schedule", "hard",
    `SELECT COUNT(*)::int AS n FROM teacher_assignments WHERE booking_id IS NULL AND schedule_id IS NULL`);
  await add("home_bookings_with_schedule_fields", "Home bookings carrying schedule/slot/time fields (preserved, never rejected)", "info",
    `SELECT COUNT(*)::int AS n FROM bookings WHERE location::text = 'Home' AND (schedule_id IS NOT NULL OR slot_id IS NOT NULL OR start_time IS NOT NULL OR end_time IS NOT NULL)`);
  await add("bookings_with_teacher_fields", "bookings carrying any legacy teacher* cache column", "info",
    `SELECT COUNT(*)::int AS n FROM bookings WHERE teacher_l IS NOT NULL OR teacher_r IS NOT NULL OR teacher_w IS NOT NULL OR teacher_s IS NOT NULL OR teacher_l_email IS NOT NULL OR teacher_r_email IS NOT NULL OR teacher_w_email IS NOT NULL OR teacher_s_email IS NOT NULL`);
  await add("teacher_assignments_to_bookings", "teacher_assignments whose key resolved to a booking id", "info",
    `SELECT COUNT(*)::int AS n FROM teacher_assignments WHERE booking_id IS NOT NULL`);
  await add("teacher_assignments_to_schedules", "teacher_assignments whose key resolved to a schedule id", "info",
    `SELECT COUNT(*)::int AS n FROM teacher_assignments WHERE schedule_id IS NOT NULL`);
  for (const table of ["sessions", "accounts", "verifications"] as const) {
    await add(`better_auth_${table}`, `${table} rows (Better Auth runtime is Stage 18; must stay empty)`, "hard",
      `SELECT COUNT(*)::int AS n FROM ${table}`);
  }
  return checks;
}

/** Distinct parent ids referenced by teacher_assignments that have no loaded parent row. */
export async function danglingTeacherParents(prisma: PrismaClient, _target: VerifiedTarget): Promise<{ bookingIds: string[]; scheduleIds: string[] }> {
  const b = (await prisma.$queryRawUnsafe((`SELECT DISTINCT t.booking_id AS id FROM teacher_assignments t WHERE t.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.id = t.booking_id)`))) as Array<{ id: string }>;
  const s = (await prisma.$queryRawUnsafe((`SELECT DISTINCT t.schedule_id AS id FROM teacher_assignments t WHERE t.schedule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schedules x WHERE x.id = t.schedule_id)`))) as Array<{ id: string }>;
  return { bookingIds: b.map((r) => r.id).sort(), scheduleIds: s.map((r) => r.id).sort() };
}
