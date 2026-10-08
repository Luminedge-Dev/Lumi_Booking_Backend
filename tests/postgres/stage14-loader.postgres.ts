// Stage 14 -- live PostgreSQL loader proof on Neon branch stage13-dev ONLY.
//
// Uses clearly-fake ids (prefix 5ade14aa...) so it can never touch loaded
// migration data, and removes every row it created in `finally`. It proves:
//   * the loader commits exactly what the transform produced (digest equality),
//   * a second load is idempotent (same rows, same digests, no duplicates),
//   * a failing batch rolls back completely (the replace-by-root-id delete too),
//   * the loader refuses to run without a verified target.
//
// Run with: pnpm test:postgres   (requires NEON_DB_URL + NEON_DIRECT_URL for stage13-dev)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config as loadDotenv } from "dotenv";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { verifyStage13Target, StopError } from "../../scripts/migration/stage14/guards";
import { createPrismaSink } from "../../scripts/migration/stage14/load/loader";
import type { CommitBatch, RowSink } from "../../scripts/migration/stage14/load/sink";
import { runPipeline } from "../../scripts/migration/stage14/pipeline";
import { rowDigest, TABLE_SPECS } from "../../scripts/migration/stage14/columns";
import { TABLES, type TableName } from "../../scripts/migration/stage14/common";
import { buildWorld, worldSource } from "../migration/stage14/helpers/fixtures";
import { memorySource } from "../migration/stage14/helpers/memory";

loadDotenv({ quiet: true });

const PREFIX = "5ade14aa000000000000";

function ownedWhere(table: TableName, ids: { users: string[]; courses: string[]; schedules: string[]; bookings: string[] }): Record<string, unknown> {
  switch (table) {
    case "users":
      return { id: { in: ids.users } };
    case "courses":
      return { id: { in: ids.courses } };
    case "schedules":
      return { id: { in: ids.schedules } };
    case "bookings":
      return { id: { in: ids.bookings } };
    case "schedule_slots":
    case "slot_counters":
      return { scheduleId: { in: ids.schedules } };
    default:
      return { userId: { in: ids.users } };
  }
}

function delegate(prisma: PrismaClient, table: TableName) {
  const map = {
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
  } as unknown as Record<TableName, { findMany(a: unknown): Promise<Array<Record<string, unknown>>>; deleteMany(a: unknown): Promise<unknown> }>;
  return map[table];
}

async function digestsOf(prisma: PrismaClient, table: TableName, ids: Parameters<typeof ownedWhere>[1]): Promise<Record<string, string>> {
  const spec = TABLE_SPECS[table];
  const rows = await delegate(prisma, table).findMany({ where: ownedWhere(table, ids), select: Object.fromEntries(spec.columns.map((c) => [c, true])) });
  return Object.fromEntries(rows.map((r) => [String(r[spec.pk]), rowDigest(table, r)]));
}

describe("Stage 14 PostgreSQL loader (live Neon stage13-dev)", () => {
  it("loads, is idempotent, rolls back a failing batch completely, and refuses an unverified target", async () => {
    const target = verifyStage13Target({ NEON_DB_URL: process.env.NEON_DB_URL, NEON_DIRECT_URL: process.env.NEON_DIRECT_URL });
    const prisma = getPrismaClient();
    const world = buildWorld(PREFIX);
    const ids = {
      users: [world.ids.userA.toHexString(), world.ids.userB.toHexString()],
      courses: [world.ids.course.toHexString()],
      schedules: [world.ids.schedule.toHexString()],
      bookings: [world.ids.tcBooking.toHexString(), world.ids.homeBooking.toHexString()],
    };
    const cleanup = async () => {
      for (const table of [...TABLES].reverse()) await delegate(prisma, table).deleteMany({ where: ownedWhere(table, ids) });
    };

    try {
      await cleanup();

      // --- refuses an unverified target -----------------------------------
      assert.throws(() => createPrismaSink(prisma, undefined as never), StopError);

      // --- first load ------------------------------------------------------
      const real = createPrismaSink(prisma, target);
      const batches: CommitBatch[] = [];
      const recorder: RowSink = {
        async commit(batch) {
          batches.push(batch);
          await real.commit(batch);
        },
      };
      const run = await runPipeline({ source: memorySource(worldSource(world)), sink: recorder, batchSize: 2, userBatchSize: 2 });
      assert.deepEqual(run.ledger.unbalanced(), []);
      assert.equal(run.quarantine.length, 0);

      const expected = run.expectation.toManifest();
      const first: Record<string, Record<string, string>> = {};
      for (const table of TABLES.filter((t) => !["sessions", "accounts", "verifications"].includes(t))) {
        first[table] = await digestsOf(prisma, table, ids);
        assert.deepEqual(first[table], expected[table] ?? {}, `${table}: target differs from the expected rows`);
      }
      assert.ok(Object.keys(first.users!).length === 2 && Object.keys(first.schedule_slots!).length === 2);

      // --- second load: idempotent ----------------------------------------
      await runPipeline({ source: memorySource(worldSource(world)), sink: createPrismaSink(prisma, target), batchSize: 1, userBatchSize: 1 });
      for (const table of Object.keys(first) as TableName[]) {
        assert.deepEqual(await digestsOf(prisma, table, ids), first[table], `${table}: second load changed or duplicated rows`);
      }

      // --- failing batch rolls back everything, including the replace-delete --
      const usersBatch = batches.find((b) => b.entity === "users")!;
      const mocks = usersBatch.rows.mock_allocations!;
      assert.ok(mocks.length >= 1);
      const poisoned: CommitBatch = {
        ...usersBatch,
        rows: {
          ...usersBatch.rows,
          users: usersBatch.rows.users!.map((u) => ({ ...u, name: "SHOULD-NEVER-PERSIST" })),
          mock_allocations: [...mocks, { ...mocks[0]! }], // duplicate primary key => unique violation mid-transaction
        },
      };
      await assert.rejects(() => real.commit(poisoned));
      for (const table of Object.keys(first) as TableName[]) {
        assert.deepEqual(await digestsOf(prisma, table, ids), first[table], `${table}: failed batch left partial state`);
      }
    } finally {
      await cleanup();
      for (const table of TABLES) {
        if (["sessions", "accounts", "verifications"].includes(table)) continue;
        assert.equal((await delegate(prisma, table).findMany({ where: ownedWhere(table, ids), select: { [TABLE_SPECS[table].pk]: true } })).length, 0, `${table}: test rows were not cleaned up`);
      }
      await disconnectPrisma();
    }
  });
});
