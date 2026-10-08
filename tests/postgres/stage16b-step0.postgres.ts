import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { assertStage13Target } from "./helpers/stage13-target";

// Stage 16B Step 0 — read-only census on stage13-dev. No writes.
const report: Record<string, unknown> = {};
const one = (rows: Array<{ n: number }>): number => Number(rows[0]?.n ?? 0);

describe("Stage 16B Step 0 preflight (read-only, stage13-dev)", { timeout: 180_000 }, () => {
  assertStage13Target();
  const prisma = getPrismaClient();
  after(async () => {
    console.log("STEP0_16B " + JSON.stringify(report));
    await disconnectPrisma();
  });

  it("duplicate trimmed transaction IDs and blank/NULL allocations", async () => {
    report.duplicateTrimmedTxnIdGroups = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT user_id, btrim(coalesce(transaction_id, '')) AS k
          FROM mock_allocations
          GROUP BY user_id, btrim(coalesce(transaction_id, ''))
          HAVING COUNT(*) > 1
        ) g`
    );
    report.duplicateTrimmedTxnIdRows = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COALESCE(SUM(c), 0)::int AS n FROM (
          SELECT COUNT(*)::int AS c
          FROM mock_allocations
          GROUP BY user_id, btrim(coalesce(transaction_id, ''))
          HAVING COUNT(*) > 1
        ) g`
    );
    report.usersWithMultipleBlankTxnIds = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT user_id FROM mock_allocations
          WHERE transaction_id IS NULL OR btrim(transaction_id) = ''
          GROUP BY user_id HAVING COUNT(*) > 1
        ) g`
    );
    report.nullTxnIdRows = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM mock_allocations WHERE transaction_id IS NULL`
    );
    report.blankTxnIdRows = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM mock_allocations
        WHERE transaction_id IS NOT NULL AND btrim(transaction_id) = ''`
    );
    assert.equal(typeof report.duplicateTrimmedTxnIdGroups, "number");
  });

  it("exact and case-insensitive duplicate emails (counts and ids only)", async () => {
    report.exactEmailDuplicateGroups = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM (SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1) g`
    );
    report.exactEmailDuplicateUsers = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COALESCE(SUM(c), 0)::int AS n FROM (SELECT COUNT(*)::int AS c FROM users GROUP BY email HAVING COUNT(*) > 1) g`
    );
    report.ciEmailDuplicateGroups = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM (SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) g`
    );
    report.ciEmailDuplicateUsers = one(
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COALESCE(SUM(c), 0)::int AS n FROM (SELECT COUNT(*)::int AS c FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) g`
    );
    const ciShapes = await prisma.$queryRaw<Array<{ members: number; distinct_exact: number }>>`
      SELECT COUNT(*)::int AS members, COUNT(DISTINCT email)::int AS distinct_exact
      FROM users
      WHERE lower(email) IN (SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1)
      GROUP BY lower(email)`;
    report.ciGroupShapes = ciShapes.map((g) => ({
      members: Number(g.members),
      distinctExactEmails: Number(g.distinct_exact),
    }));
    const exactWinners = await prisma.$queryRaw<Array<{ members: number }>>`
      SELECT COUNT(*)::int AS members FROM users GROUP BY email HAVING COUNT(*) > 1`;
    report.exactDuplicateGroupCountChecked = exactWinners.length;
  });

  it("integer bounds currently stored vs int4", async () => {
    const users = await prisma.$queryRaw<Array<{ max_mock: number | null; min_mock: number | null; max_total: number | null; min_total: number | null }>>`
      SELECT MAX(mock)::int AS max_mock, MIN(mock)::int AS min_mock,
             MAX(total_mock)::int AS max_total, MIN(total_mock)::int AS min_total FROM users`;
    const alloc = await prisma.$queryRaw<Array<{ max_mock: number | null; min_mock: number | null }>>`
      SELECT MAX(mock)::int AS max_mock, MIN(mock)::int AS min_mock FROM mock_allocations`;
    report.usersMockBounds = users[0];
    report.allocationMockBounds = alloc[0];
    report.int4 = { min: -2147483648, max: 2147483647 };
    const u = users[0]!;
    for (const v of [u.max_mock, u.min_mock, u.max_total, u.min_total, alloc[0]?.max_mock, alloc[0]?.min_mock]) {
      if (v === null || v === undefined) continue;
      assert.ok(v >= -2147483648 && v <= 2147483647);
    }
  });

  it("mock_allocations column set is the contracted field list", async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name::text AS column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mock_allocations'
      ORDER BY ordinal_position`;
    report.mockAllocationColumns = cols.map((c) => c.column_name);
    assert.deepEqual(
      cols.map((c) => c.column_name),
      [
        "id",
        "user_id",
        "transaction_id",
        "mock",
        "mock_type",
        "mr_validation",
        "mr_validation_expiry",
        "test_system",
        "test_type",
        "email_reminder_sent",
        "created_at",
        "updated_at",
      ]
    );
  });
});
