import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST, authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import {
  PREFLIGHT_CONNECTION_TIMEOUT_MS,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
  PreflightTimeoutError,
  executeReadOnlyPreflight,
  mapCatalog,
  type PreflightConnect,
  type PreflightConnectInput,
  type PreflightQueryResult,
  type PreflightSession,
} from "../../../scripts/migration/stage17/readonly-preflight-adapter";
import { PREFLIGHT_CHILD_ENDPOINT_ID, PREFLIGHT_STATEMENTS } from "../../../scripts/migration/stage17/readonly-preflight";
import { READ_ONLY_TRANSACTION_PROOF, READ_ONLY_TRANSACTION_SETUP_STATUS } from "../../../scripts/migration/stage17/readonly-session-contract";

const CHILD = PREFLIGHT_CHILD_ENDPOINT_ID;
const SECRET = "secret-password";

function url(endpoint: string, database = "neondb", pooled = false): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://role:${SECRET}@${host}/${database}`;
}

function childUrls(): { pooledUrl: string; directUrl: string } {
  return { pooledUrl: url(CHILD, "neondb", true), directUrl: url(CHILD) };
}

function result(rows: readonly Record<string, unknown>[]): PreflightQueryResult {
  return { rows };
}

function passingResults(patch: { tables?: string[]; foreignKeys?: Record<string, unknown>[]; sessions?: string } = {}): PreflightQueryResult[] {
  const tables = patch.tables ?? [...CLEANUP_ALLOWLIST];
  return [
    result([{ current_database: "neondb" }]),
    result(tables.map((relname) => ({ nspname: "public", relname }))),
    result(patch.foreignKeys ?? [{ referencing_schema: "public", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }]),
    result([{ count: patch.sessions ?? "0" }]),
    result([{ count: 0 }]),
    result([{ count: "0" }]),
  ];
}

function sessionFrom(
  results: readonly PreflightQueryResult[],
  events: string[],
  setup: "proof" | "flag-only" | "fail" | "timeout" = "proof",
): PreflightSession {
  let index = 0;
  return {
    async startReadOnlyTransaction() {
      events.push("setup");
      if (setup === "fail") throw new Error(`setup failed postgresql://role:${SECRET}@host/neondb`);
      if (setup === "timeout") throw new PreflightTimeoutError();
      if (setup === "flag-only") return { readOnly: true };
      return { kind: READ_ONLY_TRANSACTION_PROOF };
    },
    async query(statement: string) {
      events.push(`query:${statement}`);
      const row = results[index];
      index += 1;
      if (!row) throw new Error(`postgresql://role:${SECRET}@unexpected`);
      return row;
    },
    async close() {
      events.push("close");
    },
  };
}

function connectFrom(session: PreflightSession, events: string[], fail?: "connect" | "timeout"): PreflightConnect {
  return async (input: PreflightConnectInput) => {
    events.push("connect");
    events.push(`readOnly:${String(input.readOnly)}`);
    events.push(`connectionTimeout:${input.connectionTimeoutMs}`);
    events.push(`statementTimeout:${input.statementTimeoutMs}`);
    events.push(input.connectionString.includes(SECRET) ? "credential-present" : "credential-absent");
    if (fail === "connect") throw new Error(`connect failed postgresql://role:${SECRET}@host/neondb`);
    if (fail === "timeout") throw new PreflightTimeoutError();
    return session;
  };
}

describe("stage17 read-only preflight adapter", () => {
  it("reads the child catalog through the approved statements and grants no authority", async () => {
    const events: string[] = [];
    const report = await executeReadOnlyPreflight({
      ...childUrls(),
      connect: connectFrom(sessionFrom(passingResults(), events), events),
    });
    assert.deepEqual(events.filter((event) => event.startsWith("query:")), [...PREFLIGHT_STATEMENTS].map((statement) => `query:${statement}`));
    assert.equal(events.at(-1), "close");
    assert.equal(events.includes("readOnly:true"), true);
    assert.equal(events.includes(`connectionTimeout:${PREFLIGHT_CONNECTION_TIMEOUT_MS}`), true);
    assert.equal(events.includes(`statementTimeout:${PREFLIGHT_STATEMENT_TIMEOUT_MS}`), true);
    assert.equal(report.writeAuthority, "none");
    assert.equal(report.parentApproval, "PENDING");
    assert.equal(report.apiAttestation, "not-approved");
    assert.equal(report.endpointId, CHILD);
    assert.equal(report.databaseName, "neondb");
    assert.match(report.report, /cleanupAuthorized: false/);
    assert.equal(report.report.includes(SECRET), false);
    assert.doesNotMatch(report.report, /postgres(ql)?:\/\//i);
  });

  it("rejects the parent endpoint, the production endpoint, and a mismatched pair before connecting", async () => {
    const cases = [
      { pooledUrl: url("ep-rapid-bread-b4gi8ftb", "neondb", true), directUrl: url("ep-rapid-bread-b4gi8ftb"), message: /stage13-dev is not a rehearsal target/ },
      { pooledUrl: url("ep-falling-brook-b42o130z", "neondb", true), directUrl: url("ep-falling-brook-b42o130z"), message: /production endpoint/ },
      { pooledUrl: url(CHILD, "neondb", true), directUrl: url("ep-other-endpoint"), message: /pooled and direct endpoints differ/ },
      { pooledUrl: url(CHILD, "otherdb", true), directUrl: url(CHILD, "otherdb"), message: /database name is not neondb/ },
    ];
    for (const item of cases) {
      const events: string[] = [];
      await assert.rejects(
        () => executeReadOnlyPreflight({
          pooledUrl: item.pooledUrl,
          directUrl: item.directUrl,
          connect: connectFrom(sessionFrom(passingResults(), events), events),
        }),
        item.message,
      );
      assert.equal(events.includes("connect"), false);
      assert.equal(events.includes("close"), false);
    }
  });

  it("redacts connection failures and closes a session opened before a timeout or catalog rejection", async () => {
    const connectEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults(), connectEvents), connectEvents, "connect"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PostgreSQL connection failed/);
        assert.equal(error.message.includes(SECRET), false);
        assert.doesNotMatch(error.message, /postgres(ql)?:\/\//i);
        return true;
      },
    );
    assert.equal(connectEvents.includes("close"), false);

    const timeoutEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults(), timeoutEvents), timeoutEvents, "timeout"),
      }),
      /PostgreSQL connection timed out/,
    );
    assert.equal(timeoutEvents.includes("close"), false);

    const queryEvents: string[] = [];
    const timingOut: PreflightSession = {
      async startReadOnlyTransaction() {
        return { kind: READ_ONLY_TRANSACTION_PROOF };
      },
      async query() {
        queryEvents.push("query");
        throw new PreflightTimeoutError();
      },
      async close() {
        queryEvents.push("close");
      },
    };
    await assert.rejects(
      () => executeReadOnlyPreflight({ ...childUrls(), connect: connectFrom(timingOut, queryEvents) }),
      /PostgreSQL query timed out/,
    );
    assert.equal(queryEvents.includes("close"), true);

    const missingEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults({ tables: CLEANUP_ALLOWLIST.filter((table) => table !== "bookings") }), missingEvents), missingEvents),
      }),
      /allowlist table is missing/,
    );
    assert.equal(missingEvents.includes("close"), true);

    const foreignKeyEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults({
          foreignKeys: [{ referencing_schema: "other", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }],
        }), foreignKeyEvents), foreignKeyEvents),
      }),
      /foreign-key referencer is outside the cleanup allowlist/,
    );
    assert.equal(foreignKeyEvents.includes("close"), true);

    const malformedEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults({
          foreignKeys: [{ referencing_schema: "public.sessions", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }],
        }), malformedEvents), malformedEvents),
      }),
      /foreign-key schema is malformed/,
    );
    assert.equal(malformedEvents.includes("close"), true);

    const identityEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connectFrom(sessionFrom(passingResults({ sessions: "2" }), identityEvents), identityEvents),
      }),
      /identity tables are not empty/,
    );
    assert.equal(identityEvents.includes("close"), true);
  });

  it("rejects a session flag and a failed read-only setup before any catalog query", async () => {
    const flagEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({ ...childUrls(), connect: connectFrom(sessionFrom(passingResults(), flagEvents, "flag-only"), flagEvents) }),
      /PostgreSQL session is not read-only/,
    );
    assert.equal(flagEvents.includes("setup"), true);
    assert.equal(flagEvents.includes(`query:${PREFLIGHT_STATEMENTS[0]}`), false);
    assert.equal(flagEvents.includes("close"), true);

    const setupEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({ ...childUrls(), connect: connectFrom(sessionFrom(passingResults(), setupEvents, "fail"), setupEvents) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PostgreSQL read-only transaction setup failed/);
        assert.equal(error.message.includes(SECRET), false);
        assert.doesNotMatch(error.message, /postgres(ql)?:\/\//i);
        return true;
      },
    );
    assert.equal(setupEvents.includes(`query:${PREFLIGHT_STATEMENTS[0]}`), false);
    assert.equal(setupEvents.includes("close"), true);

    const setupTimeoutEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({ ...childUrls(), connect: connectFrom(sessionFrom(passingResults(), setupTimeoutEvents, "timeout"), setupTimeoutEvents) }),
      /PostgreSQL read-only transaction setup timed out/,
    );
    assert.equal(setupTimeoutEvents.includes("close"), true);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
  });

  it("does not read application configuration or open a write path", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-preflight-adapter.ts"), "utf8");
    assert.match(source, /reviewReadOnlyPreflight/);
    assert.match(source, /PREFLIGHT_STATEMENTS/);
    assert.match(source, /startReadOnlyTransaction/);
    assert.equal(READ_ONLY_TRANSACTION_SETUP_STATUS, "accepted-pending-grant-confirmation");
    assert.doesNotMatch(source, /dotenv|prisma|createPrismaSink|process\.env\.NEON_DB_URL|process\.env\.NEON_DIRECT_URL|process\.env\.MONGODB_URI|TRUNCATE|INSERT|UPDATE|DELETE|DROP|BEGIN|retry/);
    assert.equal(source.includes(SECRET), false);
    assert.equal(PREFLIGHT_CONNECTION_TIMEOUT_MS > 0 && PREFLIGHT_CONNECTION_TIMEOUT_MS <= 30_000, true);
    assert.equal(PREFLIGHT_STATEMENT_TIMEOUT_MS > 0 && PREFLIGHT_STATEMENT_TIMEOUT_MS <= 30_000, true);
  });

  it("accepts safe bigint counts and rejects counts outside the safe integer range", () => {
    assert.match(PREFLIGHT_STATEMENTS[0], /current_database\(\)::text AS current_database/);
    assert.match(PREFLIGHT_STATEMENTS[1], /nspname::text AS nspname/);
    assert.match(PREFLIGHT_STATEMENTS[2], /::text AS referencing_schema/);
    const catalogFor = (count: unknown) => {
      const base = passingResults();
      return [base[0], base[1], base[2], result([{ count }]), result([{ count: "0" }]), result([{ count: 0 }])];
    };
    assert.equal(mapCatalog(catalogFor(0n)).sessions, 0);
    assert.equal(mapCatalog(catalogFor(1n)).sessions, 1);
    assert.equal(mapCatalog(catalogFor(BigInt(Number.MAX_SAFE_INTEGER))).sessions, Number.MAX_SAFE_INTEGER);
    assert.equal(mapCatalog(catalogFor("0")).sessions, 0);
    assert.equal(mapCatalog(catalogFor(0)).sessions, 0);
    assert.equal(mapCatalog(passingResults({ sessions: "2" })).sessions, 2);
    for (const count of [BigInt(Number.MAX_SAFE_INTEGER) + 1n, -1n, 1.5, -2, "1.5", "nope"]) {
      assert.throws(() => mapCatalog(catalogFor(count)), /identity count is malformed/);
    }
  });
});
