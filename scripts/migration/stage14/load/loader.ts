// Stage 14 -- PostgreSQL loader (stage13-dev ONLY).
//
// Each batch is ONE interactive transaction that REPLACES everything the
// batch's root ids own:  delete owned children -> delete roots -> insert roots
// -> insert children. Because child ids are deterministic (UUIDv5 of the
// natural key), replacing converges to exactly transform(source) no matter how
// many times it runs -- that is the idempotency mechanism. If anything throws,
// the whole transaction rolls back and no half-written aggregate remains.
//
// No DDL, no raw SQL, no prisma db push / migrate. No FK exists for the
// delete to cascade through, except Better Auth sessions/accounts -> users;
// the loader REFUSES to delete a user that owns such rows instead of cascading.

import type { PrismaClient } from "../../../../src/generated/prisma/client.js";
import type { Row, SourceEntity, TableName } from "../common";
import type { VerifiedTarget } from "../guards";
import { STAGE13_DEV_ENDPOINT_ID, StopError, isVerifiedStage13Target } from "../guards";
import type { CommitBatch, RowSink } from "./sink";

type Delegate = {
  createMany(args: { data: unknown[] }): Promise<unknown>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
};

/** Json columns: a SQL NULL must be expressed by OMITTING the key (Prisma rejects a bare null). */
const JSON_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  users: ["result", "budget"],
  feedback_entries: ["feedback", "marks"],
};

interface EntityPlan {
  root: TableName;
  /** child tables, each deleted by this owner column */
  children: Array<{ table: TableName; ownerColumn: string }>;
  rootColumn: string;
}

const PLANS: Record<SourceEntity, EntityPlan> = {
  users: {
    root: "users",
    rootColumn: "id",
    children: [
      { table: "mock_allocations", ownerColumn: "userId" },
      { table: "teacher_assignments", ownerColumn: "userId" },
      { table: "feedback_entries", ownerColumn: "userId" },
      { table: "feedback_status", ownerColumn: "userId" },
      { table: "admin_sections", ownerColumn: "userId" },
      { table: "trf_emails", ownerColumn: "userId" },
      { table: "trf_email_history", ownerColumn: "userId" },
    ],
  },
  courses: { root: "courses", rootColumn: "id", children: [] },
  schedules: {
    root: "schedules",
    rootColumn: "id",
    children: [
      { table: "schedule_slots", ownerColumn: "scheduleId" },
      { table: "slot_counters", ownerColumn: "scheduleId" },
    ],
  },
  bookingMock: { root: "bookings", rootColumn: "id", children: [] },
};

export function toPrismaRow(table: TableName, row: Row): Row {
  const jsonColumns = JSON_COLUMNS[table];
  if (!jsonColumns) return row;
  const out: Row = { ...row };
  for (const column of jsonColumns) {
    if (out[column] === null) delete out[column];
  }
  return out;
}

function delegateFor(tx: PrismaClient, table: TableName): Delegate {
  const map: Record<TableName, unknown> = {
    users: tx.user,
    courses: tx.course,
    schedules: tx.schedule,
    schedule_slots: tx.scheduleSlot,
    slot_counters: tx.slotCounter,
    mock_allocations: tx.mockAllocation,
    bookings: tx.booking,
    teacher_assignments: tx.teacherAssignment,
    feedback_entries: tx.feedbackEntry,
    feedback_status: tx.feedbackStatus,
    admin_sections: tx.adminSection,
    trf_emails: tx.trfEmail,
    trf_email_history: tx.trfEmailHistory,
  };
  return map[table] as Delegate;
}

export interface LoaderOptions {
  /** Max rows per createMany (Postgres allows 65,535 bind parameters per statement). */
  insertChunkSize?: number;
  transactionTimeoutMs?: number;
}

export function createPrismaSink(prisma: PrismaClient, target: VerifiedTarget, options: LoaderOptions = {}): RowSink {
  // Runtime brand from verifyStage13Target(). Property shape, a type cast, and
  // Stage 17 rehearsal facts are not this capability. Rehearsal write authority
  // stays unavailable until Slice F attests Neon branch metadata and the connection.
  if (!isVerifiedStage13Target(target) || target.branch !== "stage13-dev" || target.endpointId !== STAGE13_DEV_ENDPOINT_ID) {
    throw new StopError("a verified stage13-dev target is required to load.");
  }
  const chunk = options.insertChunkSize ?? 400;

  return {
    async commit(batch: CommitBatch): Promise<void> {
      const plan = PLANS[batch.entity];
      await prisma.$transaction(
        async (tx) => {
          const client = tx as unknown as PrismaClient;
          if (batch.entity === "users" && batch.rootIds.length > 0) {
            const sessions = await client.session.count({ where: { userId: { in: batch.rootIds } } });
            const accounts = await client.account.count({ where: { userId: { in: batch.rootIds } } });
            if (sessions + accounts > 0) {
              throw new StopError("Better Auth rows exist for users in this batch; the ETL will not cascade-delete them.");
            }
          }
          if (batch.rootIds.length > 0) {
            for (const { table, ownerColumn } of plan.children) {
              await delegateFor(client, table).deleteMany({ where: { [ownerColumn]: { in: batch.rootIds } } });
            }
            await delegateFor(client, plan.root).deleteMany({ where: { [plan.rootColumn]: { in: batch.rootIds } } });
          }
          for (const table of [plan.root, ...plan.children.map((c) => c.table)]) {
            const rows = batch.rows[table] ?? [];
            for (let i = 0; i < rows.length; i += chunk) {
              const data = rows.slice(i, i + chunk).map((row) => toPrismaRow(table, row));
              await delegateFor(client, table).createMany({ data });
            }
          }
        },
        { maxWait: 30_000, timeout: options.transactionTimeoutMs ?? 120_000 }
      );
    },
  };
}
