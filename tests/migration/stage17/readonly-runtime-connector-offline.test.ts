import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST, authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import {
  PREFLIGHT_CONNECTION_TIMEOUT_MS,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
  executeReadOnlyPreflight,
  type PreflightConnectInput,
  type PreflightQueryResult,
} from "../../../scripts/migration/stage17/readonly-preflight-adapter";
import { PREFLIGHT_CHILD_ENDPOINT_ID, PREFLIGHT_STATEMENTS } from "../../../scripts/migration/stage17/readonly-preflight";
import {
  createReadOnlyRuntimeConnector,
  type ReadOnlySqlClient,
} from "../../../scripts/migration/stage17/readonly-runtime-connector";
import {
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_PROOF_SQL,
  READ_ONLY_ROLLBACK_SQL,
  READ_ONLY_TRANSACTION_SETUP_STATUS,
  readOnlyStatementTimeoutSql,
} from "../../../scripts/migration/stage17/readonly-session-contract";

const CHILD = PREFLIGHT_CHILD_ENDPOINT_ID;
const ROLE = "stage17_preflight_reader";
const SECRET = "secret-password";
const TIMEOUT_SQL = readOnlyStatementTimeoutSql(PREFLIGHT_STATEMENT_TIMEOUT_MS);

function url(endpoint: string, database = "neondb", pooled = false): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://role:${SECRET}@${host}/${database}`;
}

function childUrls(): { pooledUrl: string; directUrl: string } {
  return { pooledUrl: url(CHILD, "neondb", true), directUrl: url(CHILD) };
}

function proofRow(patch: Record<string, unknown> = {}): PreflightQueryResult {
  return {
    rows: [{
      transaction_read_only: "on",
      role_name: ROLE,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      ...patch,
    }],
  };
}

function catalogRows(statement: string): PreflightQueryResult {
  if (statement.startsWith("SELECT current_database()")) return { rows: [{ current_database: "neondb" }] };
  if (statement.startsWith("SELECT n.nspname")) {
    return { rows: CLEANUP_ALLOWLIST.map((relname) => ({ nspname: "public", relname })) };
  }
  if (statement.startsWith("SELECT src_ns.nspname")) {
    return { rows: [{ referencing_schema: "public", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }] };
  }
  if (statement.startsWith("SELECT count(*)")) return { rows: [{ count: "0" }] };
  throw new Error(`unexpected catalog statement ${statement}`);
}

function clientFrom(events: string[], respond: (statement: string) => PreflightQueryResult | Error): ReadOnlySqlClient {
  return {
    async query(statement: string) {
      events.push(statement);
      const outcome = respond(statement);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async end() {
      events.push("end");
    },
  };
}

function connector(events: string[], respond: (statement: string) => PreflightQueryResult | Error, urls = childUrls()) {
  return createReadOnlyRuntimeConnector({
    ...urls,
    readOnlyRole: ROLE,
    openClient: async (input: PreflightConnectInput) => {
      events.push("open");
      events.push(`timeouts:${input.connectionTimeoutMs}:${input.statementTimeoutMs}`);
      assert.equal(input.connectionString.includes(SECRET), true);
      return clientFrom(events, respond);
    },
  });
}

function happyRespond(statement: string): PreflightQueryResult | Error {
  if (statement === READ_ONLY_BEGIN_SQL || statement === READ_ONLY_ROLLBACK_SQL || statement === TIMEOUT_SQL) return { rows: [] };
  if (statement === READ_ONLY_PROOF_SQL) return proofRow();
  return catalogRows(statement);
}

describe("stage17 read-only runtime connector", () => {
  it("accepts the child endpoint, proves the read-only transaction, and grants no authority", async () => {
    const events: string[] = [];
    const report = await executeReadOnlyPreflight({
      ...childUrls(),
      connect: connector(events, happyRespond),
    });
    assert.deepEqual(events.filter((event) => event !== "open" && !event.startsWith("timeouts:")), [
      READ_ONLY_BEGIN_SQL,
      TIMEOUT_SQL,
      READ_ONLY_PROOF_SQL,
      ...PREFLIGHT_STATEMENTS,
      READ_ONLY_ROLLBACK_SQL,
      "end",
    ]);
    assert.equal(events.includes(`timeouts:${PREFLIGHT_CONNECTION_TIMEOUT_MS}:${PREFLIGHT_STATEMENT_TIMEOUT_MS}`), true);
    assert.equal(report.parentApproval, "PENDING");
    assert.equal(report.apiAttestation, "not-approved");
    assert.equal(report.writeAuthority, "none");
    assert.equal(report.endpointId, CHILD);
    assert.match(report.report, /cleanupAuthorized: false/);
    assert.equal(report.report.includes(SECRET), false);
    assert.equal(report.report.includes(ROLE), false);
    assert.doesNotMatch(report.report, /postgres(ql)?:\/\//i);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
  });

  it("rejects the parent endpoint, the production endpoint, and a privileged role before opening a client", async () => {
    const cases = [
      childPair("ep-rapid-bread-b4gi8ftb"),
      childPair("ep-falling-brook-b42o130z"),
      { pooledUrl: url(CHILD, "neondb", true), directUrl: url("ep-other-endpoint") },
    ];
    for (const urls of cases) {
      const events: string[] = [];
      await assert.rejects(
        () => executeReadOnlyPreflight({ ...urls, connect: connector(events, happyRespond, urls) }),
        /STOP:/,
      );
      assert.equal(events.includes("open"), false);
      assert.equal(events.includes("end"), false);
    }
    assert.throws(
      () => createReadOnlyRuntimeConnector({ ...childUrls(), readOnlyRole: "postgres", openClient: async () => clientFrom([], happyRespond) }),
      /dedicated read-only role/,
    );
    const directEvents: string[] = [];
    const parent = childPair("ep-rapid-bread-b4gi8ftb");
    const parentConnect = connector(directEvents, happyRespond, parent);
    await assert.rejects(
      () => parentConnect({
        connectionString: parent.directUrl,
        readOnly: true,
        connectionTimeoutMs: PREFLIGHT_CONNECTION_TIMEOUT_MS,
        statementTimeoutMs: PREFLIGHT_STATEMENT_TIMEOUT_MS,
      }),
      /stage13-dev is not a rehearsal target/,
    );
    assert.equal(directEvents.includes("open"), false);
  });

  it("stops when the server does not prove a restricted read-only transaction and still closes", async () => {
    const off: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(off, (statement) => statement === READ_ONLY_PROOF_SQL ? proofRow({ transaction_read_only: "off" }) : happyRespond(statement)),
      }),
      /PostgreSQL session is not read-only/,
    );
    assert.equal(off.includes(PREFLIGHT_STATEMENTS[0]), false);
    assert.equal(off.includes(READ_ONLY_ROLLBACK_SQL), true);
    assert.equal(off.at(-1), "end");

    const superuser: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(superuser, (statement) => statement === READ_ONLY_PROOF_SQL ? proofRow({ rolsuper: true }) : happyRespond(statement)),
      }),
      /PostgreSQL role is not restricted/,
    );
    assert.equal(superuser.at(-1), "end");

    const beginEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(beginEvents, (statement) => {
          if (statement === READ_ONLY_BEGIN_SQL) return new Error(`begin failed postgresql://role:${SECRET}@host/neondb`);
          return happyRespond(statement);
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PostgreSQL read-only transaction setup failed/);
        assert.equal(error.message.includes(SECRET), false);
        assert.doesNotMatch(error.message, /postgres(ql)?:\/\//i);
        return true;
      },
    );
    assert.equal(beginEvents.includes(READ_ONLY_ROLLBACK_SQL), true);
    assert.equal(beginEvents.at(-1), "end");
  });

  it("maps transaction and query timeouts and rejects SQL outside the catalog list", async () => {
    const setupTimeout: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(setupTimeout, (statement) => {
          if (statement === READ_ONLY_BEGIN_SQL) {
            const error = new Error("timeout expired");
            (error as { code?: string }).code = "57014";
            return error;
          }
          return happyRespond(statement);
        }),
      }),
      /PostgreSQL read-only transaction setup timed out/,
    );
    assert.equal(setupTimeout.at(-1), "end");

    const queryTimeout: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(queryTimeout, (statement) => {
          if (statement === PREFLIGHT_STATEMENTS[0]) {
            const error = new Error(`query timeout postgresql://role:${SECRET}@host/neondb`);
            error.name = "TimeoutError";
            return error;
          }
          return happyRespond(statement);
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PostgreSQL query timed out/);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      },
    );
    assert.equal(queryTimeout.includes(READ_ONLY_ROLLBACK_SQL), true);
    assert.equal(queryTimeout.at(-1), "end");

    const events: string[] = [];
    const connect = connector(events, happyRespond);
    const session = await connect({
      connectionString: childUrls().directUrl,
      readOnly: true,
      connectionTimeoutMs: PREFLIGHT_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: PREFLIGHT_STATEMENT_TIMEOUT_MS,
    });
    await session.startReadOnlyTransaction();
    await assert.rejects(() => session.query("TRUNCATE TABLE public.users"), /SQL is outside the preflight statement list/);
    await session.close();
    assert.equal(events.includes("TRUNCATE TABLE public.users"), false);
    assert.equal(events.at(-1), "end");
  });

  it("rejects malformed catalog rows and keeps grant confirmation open", async () => {
    const events: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflight({
        ...childUrls(),
        connect: connector(events, (statement) => statement.startsWith("SELECT current_database()") ? { rows: [] } : happyRespond(statement)),
      }),
      /catalog row is malformed/,
    );
    assert.equal(events.includes(READ_ONLY_ROLLBACK_SQL), true);
    assert.equal(events.at(-1), "end");
    assert.equal(READ_ONLY_TRANSACTION_SETUP_STATUS, "accepted-pending-grant-confirmation");
    const connectorSource = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-runtime-connector.ts"), "utf8");
    const contractSource = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-session-contract.ts"), "utf8");
    assert.match(contractSource, /BEGIN READ ONLY/);
    assert.match(contractSource, /transaction_read_only/);
    assert.match(connectorSource, /READ_ONLY_BEGIN_SQL/);
    assert.doesNotMatch(connectorSource, /dotenv|prisma|getPrismaClient|process\.env\.NEON_DB_URL|process\.env\.NEON_DIRECT_URL|process\.env\.MONGODB_URI|new Client|new Pool/);
    assert.equal(connectorSource.includes(SECRET), false);
  });
});

function childPair(endpoint: string): { pooledUrl: string; directUrl: string } {
  return { pooledUrl: url(endpoint, "neondb", true), directUrl: url(endpoint) };
}
