import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { isTransactionConflict, runSerializableTransaction } from "../../src/app/database/transaction";
import { getPostgresEnv } from "../../src/app/config/env";
import { AsyncBarrier } from "../transactions/helpers/async-barrier";
import { assertStage13Target } from "./helpers/stage13-target";
import { Stage16Fixtures, stage16Id, STAGE16_EMAIL_DOMAIN } from "./helpers/stage16-fixtures";

// Stage 16 Step 0 technical preflight (stage13-dev only). Proves, through the
// real Prisma + adapter-neon stack:
//   G7  parameterized FOR UPDATE, real 40001 -> P2034, bounded retry
//   G8  cold-connection and transaction-duration feasibility
//   --  complete removal of every fixture row it creates
// Results are printed as one JSON line prefixed STEP0_REPORT.

const report: Record<string, unknown> = {};
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
const stats = (values: number[]) => ({ n: values.length, min: Math.min(...values), p50: pct(values, 50), p95: pct(values, 95), max: Math.max(...values) });

class Insufficient extends Error {}

let nextCounter = 1;
const fresh = () => stage16Id(nextCounter++);

describe("Stage 16 Step 0 preflight (live stage13-dev)", { timeout: 600_000 }, () => {
  assertStage13Target();
  const prisma = getPrismaClient();
  const fixtures = new Stage16Fixtures(prisma);

  after(async () => {
    try {
      report.cleanupRemoved = await fixtures.cleanup();
      await fixtures.assertNamespaceEmpty("after cleanup");
      report.namespaceEmptyAfterCleanup = true;
    } finally {
      console.log("STEP0_REPORT " + JSON.stringify(report));
      await disconnectPrisma();
    }
  });

  async function createUser(mock: number): Promise<string> {
    const id = fixtures.trackUser(fresh());
    await prisma.user.create({
      data: { id, name: "stage16-test-user", email: `${id}@${STAGE16_EMAIL_DOMAIN}`, password: "x", role: "user", mock, totalMock: mock },
    });
    return id;
  }

  it("namespace is empty and the target is the pinned non-production compute", async () => {
    await fixtures.assertNamespaceEmpty("before run");
    report.namespaceEmptyBefore = true;
  });

  it("cold connection: first query and first transaction on a brand-new client", async () => {
    const env = getPostgresEnv();
    const client = new PrismaClient({ adapter: new PrismaNeon({ connectionString: env.databaseUrl }) });
    try {
      let t = ms();
      await client.$queryRaw`SELECT 1`;
      const firstQueryMs = ms() - t;
      t = ms();
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      }, { isolationLevel: "Serializable" });
      const firstTxMs = ms() - t;
      const warm: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        t = ms();
        await client.$queryRaw`SELECT 1`;
        warm.push(ms() - t);
      }
      report.cold = { firstQueryMs, firstTxMs, warmRoundTrip: stats(warm) };
    } finally {
      await client.$disconnect();
    }
  });

  it("parameterized FOR UPDATE works and really blocks a second locker", async () => {
    const userId = await createUser(2);
    const order: string[] = [];
    const aHasLock = new AsyncBarrier(2, 30_000);
    const a = runSerializableTransaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; mock: number }>>`SELECT id, mock FROM users WHERE id = ${userId} FOR UPDATE`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.mock, 2);
      order.push("A locked");
      await aHasLock.wait();
      await new Promise((r) => setTimeout(r, 1500));
      await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${userId} AND mock > 0`;
      order.push("A updating done");
    }, { maxAttempts: 1 });
    const b = (async () => {
      await aHasLock.wait();
      return runSerializableTransaction(async (tx) => {
        order.push("B asks lock");
        const rows = await tx.$queryRaw<Array<{ mock: number }>>`SELECT mock FROM users WHERE id = ${userId} FOR UPDATE`;
        order.push(`B got lock mock=${rows[0]?.mock}`);
      }, { maxAttempts: 1 }).then(
        () => "ok" as const,
        (error) => ({ code: (error as { code?: string }).code ?? "none" })
      );
    })();
    await a;
    const bResult = await b;
    report.forUpdateBlocking = { order, bResult };
    // B must never observe the pre-update value while holding the lock.
    assert.ok(!order.includes("B got lock mock=2"), "B read stale mock after waiting on FOR UPDATE");
  });

  it("a real serialization conflict surfaces as Prisma P2034 and is retried by the existing helper", async () => {
    const userId = await createUser(5);
    // Raw conflict first: both read, then both write the same row.
    const barrier = new AsyncBarrier(2, 30_000);
    const conflictRun = () =>
      prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT mock FROM users WHERE id = ${userId}`;
            await barrier.wait();
            await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${userId}`;
          },
          { isolationLevel: "Serializable", maxWait: 20_000, timeout: 30_000 }
        )
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, code: (error as { code?: string }).code ?? "none", name: (error as Error).name, classifiedConflict: isTransactionConflict(error) })
        );
    const results = await Promise.all([conflictRun(), conflictRun()]);
    const failed = results.filter((r) => !r.ok);
    report.rawConflict = results;
    assert.equal(failed.length, 1, "exactly one side of a forced conflict must lose");
    // Raw SQL reports 40001 as P2010; the helper must still classify it as a conflict.
    assert.equal((failed[0] as { code: string }).code, "P2010");
    assert.equal((failed[0] as { classifiedConflict: boolean }).classifiedConflict, true);
    assert.equal(isTransactionConflict({ code: "P2010", meta: {} }), false, "a plain P2010 must not be retried");
    const after = await prisma.user.findUnique({ where: { id: userId } });
    assert.equal(after?.mock, 4, "only the winner's decrement may persist");

    // Bounded retry: with maxAttempts 1 the conflict propagates unretried.
    let attempts = 0;
    const barrier2 = new AsyncBarrier(2, 30_000);
    const noRetry = (n: number) =>
      runSerializableTransaction(
        async (tx) => {
          attempts += 1;
          await tx.$queryRaw`SELECT mock FROM users WHERE id = ${userId}`;
          if (attempts <= 2) await barrier2.wait();
          await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${userId}`;
        },
        { maxAttempts: n, backoffMs: 0 }
      ).then(
        () => "ok",
        (error) => (isTransactionConflict(error) ? "CONFLICT" : "other")
      );
    const bounded = await Promise.all([noRetry(1), noRetry(1)]);
    report.boundedNoRetry = { bounded, attempts };
    assert.ok(bounded.includes("CONFLICT"), "exhausted attempts must surface the conflict, not hang or swallow it");
    // The helper must stop at maxAttempts: no more attempts than 2 contenders x 1.
    assert.equal(attempts, 2);
  });

  it("lock-first guarded decrement: N contenders on a credit of 2 -> exactly 2 win, never negative", async () => {
    for (const [contenders, maxAttempts] of [[4, 3], [6, 8]] as const) {
      const userId = await createUser(2);
      const outcomes: Array<{ outcome: string; ms: number; attempts: number }> = [];
      const runOne = async () => {
        const t0 = ms();
        let attempts = 0;
        try {
          await runSerializableTransaction(
            async (tx) => {
              attempts += 1;
              const rows = await tx.$queryRaw<Array<{ mock: number }>>`SELECT mock FROM users WHERE id = ${userId} FOR UPDATE`;
              if ((rows[0]?.mock ?? 0) <= 0) throw new Insufficient("none left");
              const updated = await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${userId} AND mock > 0`;
              if (updated !== 1) throw new Insufficient("guard miss");
            },
            { maxAttempts, backoffMs: 20, maxWaitMs: 15000, timeoutMs: 20000 }
          );
          outcomes.push({ outcome: "won", ms: ms() - t0, attempts });
        } catch (error) {
          const code = (error as { code?: string }).code;
          outcomes.push({ outcome: error instanceof Insufficient ? "insufficient" : `error:${code ?? (error as Error).name}`, ms: ms() - t0, attempts });
        }
      };
      await Promise.all(Array.from({ length: contenders }, runOne));
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const won = outcomes.filter((o) => o.outcome === "won").length;
      report[`contention_${contenders}x_maxAttempts${maxAttempts}`] = {
        won,
        insufficient: outcomes.filter((o) => o.outcome === "insufficient").length,
        errors: outcomes.filter((o) => o.outcome.startsWith("error")).map((o) => o.outcome),
        finalMock: user?.mock,
        latencyMs: stats(outcomes.map((o) => o.ms)),
        maxAttemptsUsed: Math.max(...outcomes.map((o) => o.attempts)),
      };
      assert.ok((user?.mock ?? -1) >= 0, "credit must never go negative");
      assert.equal(2 - (user?.mock ?? 0), won, "credit consumed must equal winners");
      assert.ok(won <= 2);
    }
  });

  it("Test Center shaped transaction duration (user lock, slot lock, guarded x2, insert) under default vs bounded timeouts", async () => {
    const scheduleId = fixtures.trackSchedule(fresh());
    await prisma.scheduleSlot.create({
      data: { scheduleId, position: 0, slotId: "1", seatsLeft: 1000, capacityTotal: 1000, startTime: "09:00", endTime: "10:00" },
    });
    const durations: number[] = [];
    const statementCounts: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const userId = await createUser(3);
      const bookingId = fixtures.trackBooking(fresh());
      const t0 = ms();
      let statements = 0;
      await runSerializableTransaction(async (tx) => {
        statements = 0;
        const u = await tx.$queryRaw<Array<{ mock: number }>>`SELECT mock FROM users WHERE id = ${userId} FOR UPDATE`;
        statements += 1;
        const s = await tx.$queryRaw<Array<{ seats_left: number }>>`SELECT seats_left FROM schedule_slots WHERE schedule_id = ${scheduleId} AND slot_id = ${"1"} FOR UPDATE`;
        statements += 1;
        assert.ok((u[0]?.mock ?? 0) > 0 && (s[0]?.seats_left ?? 0) > 0);
        const seat = await tx.$executeRaw`UPDATE schedule_slots SET seats_left = seats_left - 1 WHERE schedule_id = ${scheduleId} AND slot_id = ${"1"} AND seats_left > 0`;
        const credit = await tx.$executeRaw`UPDATE users SET mock = mock - 1 WHERE id = ${userId} AND mock > 0`;
        statements += 2;
        assert.equal(seat, 1);
        assert.equal(credit, 1);
        await tx.$executeRaw`INSERT INTO bookings (id, user_id, schedule_id, slot_id, name, location, booking_date, status, test_type)
          VALUES (${bookingId}, ${userId}, ${scheduleId}, ${"1"}, ${"stage16-test-booking"}, 'Test Center'::"BookingLocation", ${"2030-01-01"}::date, 'pending'::"BookingStatus", 'Computer-Based'::"TestType")`;
        statements += 1;
      });
      durations.push(ms() - t0);
      statementCounts.push(statements);
    }
    report.testCenterTx = { statementsInsideTx: statementCounts[0], latencyMs: stats(durations), samples: durations };
    const slot = await prisma.scheduleSlot.findFirst({ where: { scheduleId } });
    assert.equal(slot?.seatsLeft, 992);
  });
});
