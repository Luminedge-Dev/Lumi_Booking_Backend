import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST } from "../../../scripts/migration/stage17/allowlist";
import { PREFLIGHT_CHILD_ENDPOINT_ID, PREFLIGHT_STATEMENTS } from "../../../scripts/migration/stage17/readonly-preflight";
import { executeReadOnlyPreflightOnce, main } from "../../../scripts/migration/stage17/readonly-preflight-once";
import { Client } from "pg";
import { createPgReadOnlyClientFactory, openPgReadOnlyClient, type PgClientConfig, type PgLikeClient } from "../../../scripts/migration/stage17/readonly-pg-client";
import {
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_PROOF_SQL,
  READ_ONLY_ROLLBACK_SQL,
  READ_ONLY_TRANSACTION_SETUP_STATUS,
  readOnlyStatementTimeoutSql,
} from "../../../scripts/migration/stage17/readonly-session-contract";
import { PREFLIGHT_STATEMENT_TIMEOUT_MS } from "../../../scripts/migration/stage17/readonly-preflight-adapter";

const CHILD = PREFLIGHT_CHILD_ENDPOINT_ID;
const ROLE = "stage17_preflight_reader";
const SECRET = "secret-password";
const TIMEOUT_SQL = readOnlyStatementTimeoutSql(PREFLIGHT_STATEMENT_TIMEOUT_MS);

function url(endpoint: string, database = "neondb", pooled = false, role = ROLE): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://${role}:${SECRET}@${host}/${database}`;
}

function childUrls(): { pooledUrl: string; directUrl: string } {
  return { pooledUrl: url(CHILD, "neondb", true), directUrl: url(CHILD) };
}

function catalog(statement: string): { rows: Record<string, unknown>[] } {
  if (statement === READ_ONLY_BEGIN_SQL || statement === READ_ONLY_ROLLBACK_SQL || statement === TIMEOUT_SQL) return { rows: [] };
  if (statement === READ_ONLY_PROOF_SQL) {
    return { rows: [{ transaction_read_only: "on", role_name: ROLE, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false }] };
  }
  if (statement === "SELECT current_database()") return { rows: [{ current_database: "neondb" }] };
  if (statement.startsWith("SELECT n.nspname")) return { rows: CLEANUP_ALLOWLIST.map((relname) => ({ nspname: "public", relname })) };
  if (statement.startsWith("SELECT src_ns.nspname")) {
    return { rows: [{ referencing_schema: "public", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }] };
  }
  if (statement.startsWith("SELECT count(*)")) return { rows: [{ count: "0" }] };
  throw new Error("unexpected statement");
}

function factory(events: string[], respond: (statement: string) => { rows: Record<string, unknown>[] } | Error = catalog, role = ROLE) {
  return createPgReadOnlyClientFactory({
    expectedRole: role,
    createClient(config: PgClientConfig): PgLikeClient {
      events.push("create");
      events.push(`ssl:${String(config.ssl.rejectUnauthorized)}`);
      events.push(`connectionTimeout:${config.connectionTimeoutMillis}`);
      events.push(`queryTimeout:${config.query_timeout}`);
      events.push(`statementTimeout:${config.statement_timeout}`);
      return {
        async connect() {
          events.push("connect");
        },
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
    },
  });
}

describe("stage17 read-only preflight pg bridge", () => {
  it("composes the child preflight through one pg client and grants no authority", async () => {
    const events: string[] = [];
    const report = await executeReadOnlyPreflightOnce({
      ...childUrls(),
      readOnlyRole: ROLE,
      openClient: factory(events),
    });
    assert.equal(events.filter((event) => event === "create").length, 1);
    assert.equal(events.includes("ssl:true"), true);
    assert.equal(events.includes("connectionTimeout:5000"), true);
    assert.equal(events.includes("queryTimeout:10000"), true);
    assert.equal(events.includes("statementTimeout:10000"), true);
    assert.deepEqual(events.filter((event) => event === READ_ONLY_BEGIN_SQL || event === TIMEOUT_SQL || event === READ_ONLY_PROOF_SQL || event === READ_ONLY_ROLLBACK_SQL || PREFLIGHT_STATEMENTS.includes(event as typeof PREFLIGHT_STATEMENTS[number])), [
      READ_ONLY_BEGIN_SQL,
      TIMEOUT_SQL,
      READ_ONLY_PROOF_SQL,
      ...PREFLIGHT_STATEMENTS,
      READ_ONLY_ROLLBACK_SQL,
    ]);
    assert.equal(events.at(-1), "end");
    assert.equal(report.writeAuthority, "none");
    assert.equal(report.apiAttestation, "not-approved");
    assert.equal(report.parentApproval, "PENDING");
    assert.equal(report.report.includes(SECRET), false);
    assert.equal(READ_ONLY_TRANSACTION_SETUP_STATUS, "accepted-pending-grant-confirmation");
  });

  it("rejects the parent endpoint, a role mismatch, and a TLS bypass before creating a client", async () => {
    const parentEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        pooledUrl: url("ep-rapid-bread-b4gi8ftb", "neondb", true),
        directUrl: url("ep-rapid-bread-b4gi8ftb"),
        readOnlyRole: ROLE,
        openClient: factory(parentEvents),
      }),
      /stage13-dev is not a rehearsal target/,
    );
    const productionEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        pooledUrl: url("ep-falling-brook-b42o130z", "neondb", true),
        directUrl: url("ep-falling-brook-b42o130z"),
        readOnlyRole: ROLE,
        openClient: factory(productionEvents),
      }),
      /production endpoint/,
    );
    const roleEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        pooledUrl: url(CHILD, "neondb", true, "other_reader"),
        directUrl: url(CHILD, "neondb", false, "other_reader"),
        readOnlyRole: ROLE,
        openClient: factory(roleEvents),
      }),
      /dedicated read-only role/,
    );
    const tlsEvents: string[] = [];
    await assert.rejects(
      () => createPgReadOnlyClientFactory({ expectedRole: ROLE, createClient() { tlsEvents.push("create"); return { async connect() {}, async query() { return { rows: [] }; }, async end() {} }; } })({
        connectionString: `${url(CHILD)}?sslmode=disable`,
        readOnly: true,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 10_000,
      }),
      /TLS certificate verification is required/,
    );
    assert.equal(parentEvents.includes("create"), false);
    assert.equal(productionEvents.includes("create"), false);
    assert.equal(roleEvents.includes("create"), false);
    assert.equal(tlsEvents.includes("create"), false);

    const requireEvents: string[] = [];
    let requireConfig: PgClientConfig | undefined;
    await openPgReadOnlyClient({
      connectionString: `${url(CHILD)}?sslmode=require`,
      readOnly: true,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    }, {
      expectedRole: ROLE,
      createClient(config) {
        requireEvents.push("create");
        requireConfig = config;
        return { async connect() {}, async query() { return { rows: [] }; }, async end() {} };
      },
    });
    assert.equal(requireEvents.includes("create"), true);
    assert.ok(requireConfig);
    assert.equal(requireConfig.connectionString.includes("sslmode"), false);
    const effective = new Client(requireConfig);
    const ssl = (effective as { connectionParameters?: { ssl?: { rejectUnauthorized?: unknown; checkServerIdentity?: unknown } } }).connectionParameters?.ssl;
    assert.equal(ssl?.rejectUnauthorized, true);
    assert.equal(typeof ssl?.checkServerIdentity, "undefined");

    const unsafe = [
      "sslmode=verify-ca",
      "sslmode=no-verify",
      "sslmode=prefer",
      "sslmode=allow",
      "uselibpqcompat=true&sslmode=require",
      "ssl=no-verify",
      "sslrootcert=system",
    ];
    for (const query of unsafe) {
      const events: string[] = [];
      await assert.rejects(
        () => openPgReadOnlyClient({
          connectionString: `${url(CHILD)}?${query}`,
          readOnly: true,
          connectionTimeoutMs: 5_000,
          statementTimeoutMs: 10_000,
        }, {
          expectedRole: ROLE,
          createClient() {
            events.push("create");
            return { async connect() {}, async query() { return { rows: [] }; }, async end() {} };
          },
        }),
        /TLS certificate verification is required/,
      );
      assert.equal(events.includes("create"), false);
    }
  });

  it("sanitizes connection failure, proof failure, and timeout, and still closes the client", async () => {
    const connectEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        ...childUrls(),
        readOnlyRole: ROLE,
        openClient: createPgReadOnlyClientFactory({
          expectedRole: ROLE,
          createClient(): PgLikeClient {
            connectEvents.push("create");
            return {
              async connect() {
                throw new Error(`connect failed postgresql://${ROLE}:${SECRET}@host/neondb`);
              },
              async query() { return { rows: [] }; },
              async end() { connectEvents.push("end"); },
            };
          },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PostgreSQL driver failed/);
        assert.equal(error.message.includes(SECRET), false);
        assert.doesNotMatch(error.message, /postgres(ql)?:\/\//i);
        return true;
      },
    );
    assert.equal(connectEvents.includes("end"), true);

    const proofEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        ...childUrls(),
        readOnlyRole: ROLE,
        openClient: factory(proofEvents, (statement) => statement === READ_ONLY_PROOF_SQL ? { rows: [{ transaction_read_only: "off", role_name: ROLE, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false }] } : catalog(statement)),
      }),
      /PostgreSQL session is not read-only/,
    );
    assert.equal(proofEvents.includes(READ_ONLY_ROLLBACK_SQL), true);
    assert.equal(proofEvents.at(-1), "end");

    const timeoutEvents: string[] = [];
    await assert.rejects(
      () => executeReadOnlyPreflightOnce({
        ...childUrls(),
        readOnlyRole: ROLE,
        openClient: factory(timeoutEvents, (statement) => {
          if (statement === READ_ONLY_BEGIN_SQL) {
            const error = new Error("timeout expired");
            (error as { code?: string }).code = "57014";
            return error;
          }
          return catalog(statement);
        }),
      }),
      /read-only transaction setup timed out/,
    );
    assert.equal(timeoutEvents.at(-1), "end");
  });

  it("stops the entrypoint before connecting when inputs are absent and writes only a sanitized report", async () => {
    const events: string[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];
    const originalErr = process.stderr.write;
    const originalOut = process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const absent = await main({}, ["node", "script"], factory(events));
      assert.equal(absent, 1);
      assert.match(stderr.join(""), /a preflight input is absent/);
      assert.equal(events.includes("create"), false);

      stderr.length = 0;
      const urls = childUrls();
      const code = await main({
        STAGE17_PREFLIGHT_POOLED_URL: urls.pooledUrl,
        STAGE17_PREFLIGHT_DIRECT_URL: urls.directUrl,
        STAGE17_PREFLIGHT_ROLE: ROLE,
      }, ["node", "script"], factory(events));
      assert.equal(code, 0);
      assert.match(stdout.join(""), /writeAuthority: none/);
      assert.match(stdout.join(""), /apiAttestation: not-approved/);
      assert.equal(stdout.join("").includes(SECRET), false);
      assert.equal(stdout.join("").includes(urls.directUrl), false);
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    }

    const bridge = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-pg-client.ts"), "utf8");
    const entry = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-preflight-once.ts"), "utf8");
    assert.match(bridge, /new Client/);
    assert.match(bridge, /rejectUnauthorized: true/);
    assert.doesNotMatch(bridge, /rejectUnauthorized:\s*false/);
    assert.doesNotMatch(`${bridge}\n${entry}`, /dotenv|process\.env\.NEON_DB_URL|process\.env\.NEON_DIRECT_URL|process\.env\.MONGODB_URI|new Pool/);
    assert.equal(bridge.includes(SECRET), false);
  });
});
