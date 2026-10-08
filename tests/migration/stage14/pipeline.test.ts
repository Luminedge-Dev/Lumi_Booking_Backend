// Stage 14 -- pipeline behavior over an in-memory read-only source: ledger
// balance, dry-run purity, idempotent rerun, batch-failure rollback, resume
// convergence, and the reconciliation math. No database is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { TABLES, type RawDoc, type TableName } from "../../../scripts/migration/stage14/common";
import { rowDigest, rowKey } from "../../../scripts/migration/stage14/columns";
import { isAfterToken, runPipeline, type PipelineResult } from "../../../scripts/migration/stage14/pipeline";
import { compareTable, ledgerEquation } from "../../../scripts/migration/stage14/reconcile/compare";
import type { CursorToken } from "../../../scripts/migration/stage14/extract/source";
import { buildWorld, userDoc, worldSource } from "./helpers/fixtures";
import { memorySink, memorySource, type MemorySink } from "./helpers/memory";

/** A bigger world: many users/bookings so multi-batch + mid-entity resume are real. */
function bigSource() {
  const world = buildWorld();
  const users: RawDoc[] = [world.userA, world.userB];
  const bookings: RawDoc[] = [world.testCenterBooking, world.homeBooking];
  for (let i = 0; i < 6; i += 1) {
    const id = new ObjectId(`65000000000000000000e0${i.toString(16).padStart(2, "0")}`);
    users.push(userDoc(id));
    bookings.push({ ...world.homeBooking, _id: new ObjectId(`65000000000000000000f0${i.toString(16).padStart(2, "0")}`), userId: id });
  }
  // deliberately dirty documents: each must be quarantined with a reason, not dropped
  users.push(userDoc(new ObjectId("65000000000000000000e0aa"), { status: null }));
  bookings.push({ ...world.testCenterBooking, _id: new ObjectId("65000000000000000000f0aa"), slotId: "99" });
  const noLocation = { ...world.homeBooking, _id: new ObjectId("65000000000000000000f0ab") } as Record<string, unknown>;
  delete noLocation.location;
  bookings.push(noLocation);
  return { users, courses: [world.course], schedules: [world.schedule], bookingMock: bookings };
}

function tablesDigests(sink: MemorySink): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [table, rows] of sink.tables) {
    out[table] = {};
    for (const row of rows.values()) out[table]![rowKey(table, row)] = rowDigest(table, row);
  }
  return out;
}

function rowCount(sink: MemorySink): Record<string, number> {
  return Object.fromEntries([...sink.tables].map(([t, rows]) => [t, rows.size]));
}

describe("Stage 14 pipeline: ledger", () => {
  it("balances source = accepted + quarantined + skipped on every table, with zero skipped, and explains each dirty record", async () => {
    const result = await runPipeline({ source: memorySource(bigSource()), batchSize: 3, userBatchSize: 2 });
    assert.deepEqual(result.ledger.unbalanced(), []);
    const snap = result.ledger.snapshot();
    for (const table of TABLES) {
      const l = snap[table];
      assert.equal(l.source, l.accepted + l.quarantined + l.skipped, `${table} unbalanced`);
      assert.equal(l.skipped, 0, `${table}: nothing may be skipped without approval`);
    }
    assert.equal(snap.users.quarantined, 1);
    assert.equal(snap.bookings.quarantined, 2);
    assert.deepEqual(
      result.quarantine.filter((q) => q.kind === "bookings").map((q) => q.code).sort(),
      ["MISSING_REQUIRED_FIELD", "SLOT_NOT_FOUND_IN_SCHEDULE"]
    );
    for (const q of result.quarantine) {
      assert.ok(q.code.length > 0 && q.summary.length > 0 && q.sourceId.length > 0, "every quarantine entry carries a reason");
    }
  });

  it("matches ledgerEquation arithmetic and flags an imbalance", () => {
    assert.deepEqual(ledgerEquation({ source: 10, accepted: 7, quarantined: 3, skipped: 0 }), { balanced: true, delta: 0 });
    assert.deepEqual(ledgerEquation({ source: 10, accepted: 7, quarantined: 2, skipped: 0 }), { balanced: false, delta: 1 });
  });
});

describe("Stage 14 pipeline: dry-run purity", () => {
  it("writes nothing and commits nothing without a sink", async () => {
    const result = await runPipeline({ source: memorySource(bigSource()), batchSize: 2, userBatchSize: 2 });
    assert.equal(result.mode, "dry-run");
    for (const table of TABLES) assert.equal(result.ledger.line(table).committed, 0);
  });

  it("is deterministic: two dry-runs produce an identical expected manifest and quarantine", async () => {
    const a = await runPipeline({ source: memorySource(bigSource()), batchSize: 2, userBatchSize: 2 });
    const b = await runPipeline({ source: memorySource(bigSource()), batchSize: 5, userBatchSize: 3 });
    assert.deepEqual(a.expectation.toManifest(), b.expectation.toManifest());
    assert.deepEqual(a.quarantine, b.quarantine);
  });
});

describe("Stage 14 pipeline: load, idempotency, rollback and resume (in-memory sink)", () => {
  it("first load commits exactly the accepted rows; the target digests equal the expectation", async () => {
    const sink = memorySink();
    const result = await runPipeline({ source: memorySource(bigSource()), sink, batchSize: 3, userBatchSize: 2 });
    for (const table of TABLES) assert.equal(result.ledger.line(table).committed, result.ledger.line(table).accepted, table);
    const expected = result.expectation.toManifest();
    const actual = tablesDigests(sink);
    for (const table of TABLES) {
      const cmp = compareTable(new Map(Object.entries(expected[table] ?? {})), new Map(Object.entries(actual[table] ?? {})));
      assert.equal(cmp.unexplained, 0, `${table}: ${JSON.stringify(cmp)}`);
      assert.equal(cmp.expected, cmp.target);
    }
  });

  it("a second load does not duplicate or corrupt: same keys, same digests, same counts", async () => {
    const sink = memorySink();
    await runPipeline({ source: memorySource(bigSource()), sink, batchSize: 3, userBatchSize: 2 });
    const before = { counts: rowCount(sink), digests: tablesDigests(sink) };
    await runPipeline({ source: memorySource(bigSource()), sink, batchSize: 4, userBatchSize: 3 });
    assert.deepEqual(rowCount(sink), before.counts);
    assert.deepEqual(tablesDigests(sink), before.digests);
  });

  it("a failing batch leaves no partial state, and a rerun converges to the clean-run state", async () => {
    const clean = memorySink();
    await runPipeline({ source: memorySource(bigSource()), sink: clean, batchSize: 3, userBatchSize: 2 });

    const flaky = memorySink({ failAtCommit: 4 });
    await assert.rejects(() => runPipeline({ source: memorySource(bigSource()), sink: flaky, batchSize: 3, userBatchSize: 2 }), /injected batch failure/);
    assert.equal(flaky.commits, 3, "the failed batch must not be counted as committed");
    // the failed batch's rows must not be partially visible
    const committedUsers = flaky.tables.get("users")?.size ?? 0;
    assert.ok(committedUsers < (clean.tables.get("users")?.size ?? 0));

    // whole-run retry converges
    const retrySink = flaky;
    await runPipeline({ source: memorySource(bigSource()), sink: retrySink, batchSize: 3, userBatchSize: 2 });
    assert.deepEqual(tablesDigests(retrySink), tablesDigests(clean));
  });

  it("resume after a mid-run failure converges to the clean-run state (including a resume point inside the users entity)", async () => {
    const clean = memorySink();
    await runPipeline({ source: memorySource(bigSource()), sink: clean, batchSize: 2, userBatchSize: 2 });

    for (const failAt of [1, 2, 3, 5, 7]) {
      const flaky = memorySink({ failAtCommit: failAt });
      let last: { entity: "users" | "courses" | "schedules" | "bookingMock"; token: CursorToken } | undefined;
      await assert.rejects(
        () =>
          runPipeline({
            source: memorySource(bigSource()),
            sink: flaky,
            batchSize: 2,
            userBatchSize: 2,
            onCheckpoint: ({ entity, token }) => {
              last = { entity, token };
            },
          }),
        /injected batch failure/
      );
      const resumed: PipelineResult = await runPipeline({
        source: memorySource(bigSource()),
        sink: flaky,
        batchSize: 2,
        userBatchSize: 2,
        resumeFrom: last ? { entity: last.entity, token: last.token } : { entity: "users" },
      });
      assert.equal(resumed.resumed, true);
      assert.deepEqual(tablesDigests(flaky), tablesDigests(clean), `resume after failure at commit ${failAt} did not converge`);
      assert.deepEqual(resumed.ledger.unbalanced(), []);
    }
  });

  it("re-quarantined data that was loaded earlier is removed on the next load (replace-by-root-id), never left stale", async () => {
    const source = bigSource();
    const sink = memorySink();
    await runPipeline({ source: memorySource(source), sink, batchSize: 3, userBatchSize: 2 });
    const bookingId = source.bookingMock[0]!._id as ObjectId;
    assert.ok(sink.tables.get("bookings")!.has(bookingId.toHexString()));
    // the booking becomes invalid in the source (slot removed): it must disappear from the target
    source.bookingMock[0] = { ...source.bookingMock[0]!, slotId: "99" };
    await runPipeline({ source: memorySource(source), sink, batchSize: 3, userBatchSize: 2 });
    assert.equal(sink.tables.get("bookings")!.has(bookingId.toHexString()), false);
  });
});

describe("Stage 14 pipeline: isAfterToken ordering", () => {
  it("orders by BSON bracket first (string < objectId), then by value", () => {
    const token: CursorToken = { bracket: "string", last: "abc" };
    assert.equal(isAfterToken("abd", token), true);
    assert.equal(isAfterToken("abc", token), false);
    assert.equal(isAfterToken(new ObjectId(), token), true);
    const oid: CursorToken = { bracket: "objectId", last: "650000000000000000000050" };
    assert.equal(isAfterToken("zzz", oid), false);
    assert.equal(isAfterToken(new ObjectId("650000000000000000000051"), oid), true);
    assert.equal(isAfterToken(new ObjectId("650000000000000000000050"), oid), false);
  });
});

describe("Stage 14 reconciliation math", () => {
  const expected = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);

  it("is clean when expected and target digests are identical", () => {
    const r = compareTable(expected, new Map(expected));
    assert.deepEqual([r.unexplained, r.explainedDrift, r.missingInTarget.length, r.unexpectedInTarget.length, r.digestMismatch.length], [0, 0, 0, 0, 0]);
  });

  it("counts missing, unexpected and corrupted rows as UNEXPLAINED when there is no manifest proof", () => {
    const target = new Map([["a", "1"], ["b", "X"], ["z", "9"]]);
    const r = compareTable(expected, target);
    assert.deepEqual(r.missingInTarget, ["c"]);
    assert.deepEqual(r.unexpectedInTarget, ["z"]);
    assert.deepEqual(r.digestMismatch, ["b"]);
    assert.equal(r.unexplained, 3);
  });

  it("explains a difference ONLY when the previous load manifest proves the source changed since", () => {
    const previous = { a: "1", b: "OLD", z: "9" };
    // c is new in the source (not in the previous load); b changed in the source (target still OLD); z was removed from the source (target still 9)
    const target = new Map([["a", "1"], ["b", "OLD"], ["z", "9"]]);
    const r = compareTable(expected, target, previous);
    assert.equal(r.explainedDrift, 3);
    assert.equal(r.unexplained, 0);
    // a target row that does NOT match what was loaded is still unexplained
    const corrupted = compareTable(expected, new Map([["a", "1"], ["b", "CORRUPT"], ["z", "9"], ["c", "3"]]), previous);
    assert.ok(corrupted.unexplained >= 1);
  });

  it("digests treat undefined and null as the same SQL NULL, and differ on any real change", () => {
    const base = { id: "x", name: "n", image: "i", homeBasedSystems: [] as string[], createdAt: null, updatedAt: undefined };
    assert.equal(rowDigest("courses" as TableName, base), rowDigest("courses" as TableName, { ...base, createdAt: undefined, updatedAt: null }));
    assert.notEqual(rowDigest("courses" as TableName, base), rowDigest("courses" as TableName, { ...base, name: "other" }));
  });
});

describe("Stage 14 sanity: the shared world loads cleanly", () => {
  it("the unmodified fixture world has zero quarantine", async () => {
    const result = await runPipeline({ source: memorySource(worldSource(buildWorld())), batchSize: 2, userBatchSize: 2 });
    assert.equal(result.quarantine.length, 0);
    assert.deepEqual(result.ledger.unbalanced(), []);
  });
});
