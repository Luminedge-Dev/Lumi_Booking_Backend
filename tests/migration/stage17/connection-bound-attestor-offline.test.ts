import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST } from "../../../scripts/migration/stage17/allowlist";
import {
  ATTESTOR_ROLE,
  classifyLiveEvidence,
  executeConnectionBoundAttestation,
  SET_TRANSACTION_READ_ONLY_SQL,
  type AttestorPrismaClient,
  type OpenAttestorPrisma,
} from "../../../scripts/migration/stage17/connection-bound-attestor";
import type { NeonApiFetch, NeonApiRequest } from "../../../scripts/migration/stage17/neon-api-transport";
import { OPERATOR_OBSERVED } from "../../../scripts/migration/stage17/neon-discover-once";
import { PREFLIGHT_STATEMENT_TIMEOUT_MS, PreflightTimeoutError, type PreflightQueryResult } from "../../../scripts/migration/stage17/readonly-preflight-adapter";
import { PREFLIGHT_CHILD_ENDPOINT_ID, PREFLIGHT_STATEMENTS } from "../../../scripts/migration/stage17/readonly-preflight";
import { READ_ONLY_PROOF_SQL, READ_ONLY_ROLLBACK_SQL, readOnlyStatementTimeoutSql } from "../../../scripts/migration/stage17/readonly-session-contract";
import { STAGE13_DEV_ENDPOINT_ID } from "../../../scripts/migration/stage17/rehearsal-guard";

const NOW = "2026-10-11T06:00:00.000Z";
const SECRET = "secret-password";
const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/connection-bound-attestor.ts"), "utf8");
const PREFLIGHT_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-preflight.ts"), "utf8");

function url(endpoint: string, database = "neondb", pooled = false, role = ATTESTOR_ROLE): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://${role}:${SECRET}@${host}/${database}`;
}

function childUrls(): { pooledUrl: string; directUrl: string } {
  return { pooledUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID, "neondb", true), directUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID) };
}

function page(body: unknown) {
  return { status: 200, headers: { get: () => null }, json: async () => body };
}

function branches(parentId: string = OPERATOR_OBSERVED.parentBranchId) {
  return {
    branches: [
      { id: OPERATOR_OBSERVED.productionBranchId, name: "production", parent_id: null },
      { id: parentId, name: "stage13-dev", parent_id: OPERATOR_OBSERVED.productionBranchId },
      { id: OPERATOR_OBSERVED.childBranchId, name: OPERATOR_OBSERVED.childName, parent_id: parentId },
    ],
    pagination: { sort_order: "desc" },
  };
}

function matchingFetch(
  endpoints: { id: string; branch_id: string }[] = [
    { id: OPERATOR_OBSERVED.parentEndpointId, branch_id: OPERATOR_OBSERVED.parentBranchId },
    { id: OPERATOR_OBSERVED.childEndpointId, branch_id: OPERATOR_OBSERVED.childBranchId },
  ],
  parentId: string = OPERATOR_OBSERVED.parentBranchId,
): { fetchImpl: NeonApiFetch; requests: NeonApiRequest[] } {
  const requests: NeonApiRequest[] = [];
  const fetchImpl: NeonApiFetch = async (request) => {
    requests.push(request);
    if (request.method !== "GET") throw new Error("write method");
    if (request.url.pathname.endsWith("/branches")) return page(branches(parentId));
    if (request.url.pathname.endsWith("/endpoints")) return page({ endpoints });
    return page({ project: { id: OPERATOR_OBSERVED.projectId } });
  };
  return { fetchImpl, requests };
}

function proofRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_read_only: "on",
    role_name: ATTESTOR_ROLE,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    ...overrides,
  };
}

function catalog(statement: string, counts: string | number | bigint = "0", foreignKey = { referencing_table: "sessions" }): PreflightQueryResult {
  if (statement === READ_ONLY_PROOF_SQL) return { rows: [proofRow()] };
  if (statement.startsWith("SELECT current_database()")) return { rows: [{ current_database: "neondb" }] };
  if (statement.startsWith("SELECT n.nspname")) return { rows: CLEANUP_ALLOWLIST.map((relname) => ({ nspname: "public", relname })) };
  if (statement.startsWith("SELECT src_ns.nspname")) {
    return { rows: [{ referencing_schema: "public", referencing_table: foreignKey.referencing_table, referenced_schema: "public", referenced_table: "users" }] };
  }
  if (statement.startsWith("SELECT count(*)")) return { rows: [{ count: counts }] };
  return { rows: [] };
}

function fakeOpen(events: string[], sql: string[], options: {
  txToken?: object;
  proof?: Record<string, unknown>;
  counts?: string | number | bigint;
  foreignTable?: string;
  failOpen?: Error;
  failQuery?: Error;
  failCatalog?: Error;
  failExecute?: (statement: string) => Error | undefined;
  failDisconnect?: Error;
} = {}): OpenAttestorPrisma {
  return async () => {
    events.push("open");
    if (options.failOpen) throw options.failOpen;
    const token = {};
    const client: AttestorPrismaClient = {
      token,
      async runReadOnly(work) {
        events.push("transaction");
        await work({
          token: options.txToken ?? token,
          async execute(statement) {
            sql.push(statement);
            const failure = options.failExecute?.(statement);
            if (failure) throw failure;
          },
          async query(statement) {
            sql.push(statement);
            if (options.failQuery) throw options.failQuery;
            if (options.failCatalog && statement.startsWith("SELECT current_database")) throw options.failCatalog;
            if (statement === READ_ONLY_PROOF_SQL && options.proof) return { rows: [options.proof] };
            return catalog(statement, options.counts, { referencing_table: options.foreignTable ?? "sessions" });
          },
        });
      },
      async disconnect() {
        events.push("disconnect");
        if (options.failDisconnect) throw options.failDisconnect;
      },
    };
    return client;
  };
}

async function run(partial: {
  pooledUrl?: string;
  directUrl?: string;
  fetchImpl?: NeonApiFetch;
  clock?: () => string;
  openPrisma?: OpenAttestorPrisma;
} = {}) {
  const fetched = matchingFetch();
  const urls = childUrls();
  return executeConnectionBoundAttestation({
    pooledUrl: partial.pooledUrl ?? urls.pooledUrl,
    directUrl: partial.directUrl ?? urls.directUrl,
    token: "fixture-token",
    fetchImpl: partial.fetchImpl ?? fetched.fetchImpl,
    clock: partial.clock ?? (() => NOW),
    openPrisma: partial.openPrisma ?? fakeOpen([], []),
  });
}

describe("stage17 connection-bound attestor", () => {
  it("does not perform live I/O when imported", () => {
    assert.doesNotMatch(SOURCE, /getPrismaClient|authorizeCleanupExecution|NEON_DB_URL|NEON_DIRECT_URL|MONGODB_URI|NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.match(PREFLIGHT_SOURCE, /apiAttestation: "not-approved"/);
    assert.match(SOURCE, /SET TRANSACTION READ ONLY/);
    assert.match(SOURCE, /new PrismaNeon/);
    assert.match(SOURCE, /new PrismaClient/);
  });

  it("passes an approved mapping with an injected client and no live claim", async () => {
    const events: string[] = [];
    const sql: string[] = [];
    const { fetchImpl, requests } = matchingFetch();
    const result = await executeConnectionBoundAttestation({
      ...childUrls(),
      token: "fixture-token",
      fetchImpl,
      clock: () => NOW,
      openPrisma: fakeOpen(events, sql),
    });
    assert.equal(result.connectionBoundChecks, "passed");
    assert.equal(result.neonApiEndpointOwnership, "verified");
    assert.equal(result.databaseSessionIdentity, "verified");
    assert.equal(result.operatorApprovalForLaterOperations, "required");
    assert.equal(result.evidenceClass, "injected-fixture");
    assert.equal(result.liveEvidence, "not-attested");
    assert.equal(result.apiAttestation, "not-approved");
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.cleanupAuthorized, false);
    assert.equal(result.loadAuthorized, false);
    assert.equal(result.productionWriteAuthority, "none");
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.deepEqual(events, ["open", "transaction", "disconnect"]);
    assert.equal(sql[0], SET_TRANSACTION_READ_ONLY_SQL);
    assert.match(READ_ONLY_PROOF_SQL, /current_user::text AS role_name/);
    assert.match(PREFLIGHT_STATEMENTS[0], /current_database\(\)::text AS current_database/);
    assert.match(PREFLIGHT_STATEMENTS[1], /nspname::text AS nspname/);
    assert.match(PREFLIGHT_STATEMENTS[1], /relname::text AS relname/);
    assert.match(PREFLIGHT_STATEMENTS[2], /::text AS referencing_schema/);
    assert.equal(sql[1], READ_ONLY_PROOF_SQL);
    assert.equal(sql[2], readOnlyStatementTimeoutSql(PREFLIGHT_STATEMENT_TIMEOUT_MS));
    assert.deepEqual(sql.slice(3, 3 + PREFLIGHT_STATEMENTS.length), [...PREFLIGHT_STATEMENTS]);
    assert.equal(sql.at(-1), READ_ONLY_ROLLBACK_SQL);
    assert.doesNotMatch(result.report, new RegExp(SECRET));
    assert.doesNotMatch(result.report, /fixture-token|postgres(ql)?:\/\//i);
  });

  it("rejects the wrong parent and does not open Prisma", async () => {
    const events: string[] = [];
    const wrongParent = "br-wrong-parent";
    const { fetchImpl } = matchingFetch([
      { id: OPERATOR_OBSERVED.parentEndpointId, branch_id: wrongParent },
      { id: OPERATOR_OBSERVED.childEndpointId, branch_id: OPERATOR_OBSERVED.childBranchId },
    ], wrongParent);
    await assert.rejects(
      () => run({ fetchImpl, openPrisma: fakeOpen(events, []) }),
      /Neon API identity does not match the approved rehearsal target/,
    );
    assert.deepEqual(events, []);
  });

  it("rejects a missing child and malformed Neon API data before opening Prisma", async () => {
    const events: string[] = [];
    const absent = matchingFetch();
    const original = absent.fetchImpl;
    const missingChild: NeonApiFetch = async (request) => {
      if (request.url.pathname.endsWith("/branches")) {
        return page({
          branches: [
            { id: OPERATOR_OBSERVED.productionBranchId, name: "production", parent_id: null },
            { id: OPERATOR_OBSERVED.parentBranchId, name: "stage13-dev", parent_id: OPERATOR_OBSERVED.productionBranchId },
          ],
          pagination: { sort_order: "desc" },
        });
      }
      if (request.url.pathname.endsWith("/endpoints")) {
        return page({ endpoints: [{ id: OPERATOR_OBSERVED.parentEndpointId, branch_id: OPERATOR_OBSERVED.parentBranchId }] });
      }
      return original(request);
    };
    await assert.rejects(() => run({ fetchImpl: missingChild, openPrisma: fakeOpen(events, []) }), /approved rehearsal target/);
    const malformed: NeonApiFetch = async () => page({ branches: "nope" });
    await assert.rejects(() => run({ fetchImpl: malformed, openPrisma: fakeOpen(events, []) }), /STOP:/);
    assert.deepEqual(events, []);
  });

  it("rejects stage13-dev, production, mismatched endpoints, the wrong database, and a privileged role", async () => {
    const events: string[] = [];
    const open = fakeOpen(events, []);
    await assert.rejects(() => run({ pooledUrl: url(STAGE13_DEV_ENDPOINT_ID, "neondb", true), directUrl: url(STAGE13_DEV_ENDPOINT_ID), openPrisma: open }), /stage13-dev/);
    await assert.rejects(() => run({ pooledUrl: url("ep-falling-brook-b42o130z", "neondb", true), directUrl: url("ep-falling-brook-b42o130z"), openPrisma: open }), /production endpoint/);
    await assert.rejects(() => run({ directUrl: url("ep-other-child-b4aaaaaa"), openPrisma: open }), /pooled and direct endpoints differ/);
    await assert.rejects(() => run({ pooledUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID, "postgres", true), directUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID, "postgres"), openPrisma: open }), /not neondb/);
    await assert.rejects(() => run({
      pooledUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID, "neondb", true, "neondb_owner"),
      directUrl: url(PREFLIGHT_CHILD_ENDPOINT_ID, "neondb", false, "neondb_owner"),
      openPrisma: open,
    }), /dedicated read-only role/);
    assert.deepEqual(events, []);
  });

  it("rejects a foreign-key referencer outside the allowlist and a nonzero identity count", async () => {
    const outside = fakeOpen([], [], { foreignTable: "outside_table" });
    await assert.rejects(() => run({ openPrisma: outside }), /foreign-key referencer is outside the cleanup allowlist/);
    const occupied = fakeOpen([], [], { counts: "1" });
    await assert.rejects(() => run({ openPrisma: occupied }), /identity tables are not empty/);
    const bigintOccupied = fakeOpen([], [], { counts: 1n });
    await assert.rejects(() => run({ openPrisma: bigintOccupied }), /identity tables are not empty/);
  });

  it("accepts a complete fixture whose identity counts are bigint zero", async () => {
    const result = await run({ openPrisma: fakeOpen([], [], { counts: 0n }) });
    assert.equal(result.connectionBoundChecks, "passed");
    assert.equal(result.liveEvidence, "not-attested");
    assert.equal(result.apiAttestation, "not-approved");
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.cleanupAuthorized, false);
    assert.equal(result.loadAuthorized, false);
    assert.equal(result.productionWriteAuthority, "none");
  });

  it("accepts an advancing clock across API and database delay, and rejects bad stamps", async () => {
    let cursor = Date.parse(NOW);
    const result = await run({
      clock: () => {
        const stamp = new Date(cursor).toISOString();
        cursor += 45_000;
        return stamp;
      },
    });
    assert.equal(result.connectionBoundChecks, "passed");
    assert.equal(result.liveEvidence, "not-attested");
    await assert.rejects(() => run({ clock: () => "not-a-time" }), /attestation evidence is missing/);
    const staleApi = new Date(Date.parse(NOW) - 6 * 60 * 1000).toISOString();
    const stale = [staleApi, NOW, NOW];
    await assert.rejects(() => run({ clock: () => stale.shift() ?? NOW }), /attestation evidence is stale/);
    const future = [new Date(Date.parse(NOW) + 60_000).toISOString(), new Date(Date.parse(NOW) + 30_000).toISOString(), NOW];
    await assert.rejects(() => run({ clock: () => future.shift() ?? NOW }), /attestation evidence is in the future/);
    const reversed = [new Date(Date.parse(NOW) - 1_000).toISOString(), new Date(Date.parse(NOW) - 30_000).toISOString(), NOW];
    await assert.rejects(() => run({ clock: () => reversed.shift() ?? NOW }), /attestation timestamps are inconsistent/);
  });

  it("requires both the approved transport and the constructed client before live evidence", () => {
    assert.equal(classifyLiveEvidence({ clientConstructed: true, transportApproved: true, clockInjected: false }), "connection-bound-observed");
    assert.equal(classifyLiveEvidence({ clientConstructed: true, transportApproved: false, clockInjected: false }), "not-attested");
    assert.equal(classifyLiveEvidence({ clientConstructed: false, transportApproved: true, clockInjected: false }), "not-attested");
    assert.equal(classifyLiveEvidence({ clientConstructed: true, transportApproved: true, clockInjected: true }), "not-attested");
  });

  it("stops when the server transaction is not read-only and when the tx is a different client", async () => {
    const events: string[] = [];
    const sql: string[] = [];
    await assert.rejects(
      () => run({ openPrisma: fakeOpen(events, sql, { proof: proofRow({ transaction_read_only: "off" }) }) }),
      /PostgreSQL session is not read-only/,
    );
    assert.equal(events.at(-1), "disconnect");
    assert.equal(sql.includes("SELECT count(*) FROM public.sessions"), false);
    const other: string[] = [];
    await assert.rejects(
      () => run({ openPrisma: fakeOpen(other, [], { txToken: {} }) }),
      /not read through the constructed client/,
    );
    assert.equal(other.at(-1), "disconnect");
  });

  it("sanitizes connection failure and timeout, and still disconnects after a query failure", async () => {
    const leaked = new Error(`connect failed postgresql://stage17_preflight_reader:${SECRET}@ep-dark-brook-b4atip73.region.neon.tech/neondb`);
    await assert.rejects(() => run({ openPrisma: fakeOpen([], [], { failOpen: leaked }) }), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /phase PRISMA_CLIENT_CONSTRUCTION category unclassified/);
      assert.doesNotMatch((error as Error).message, new RegExp(SECRET));
      assert.doesNotMatch((error as Error).message, /postgres(ql)?:\/\//i);
      return true;
    });
    const events: string[] = [];
    const timeout = new PreflightTimeoutError();
    await assert.rejects(() => run({ openPrisma: fakeOpen(events, [], { failQuery: timeout }) }), /timeout/);
    assert.equal(events.at(-1), "disconnect");
  });

  it("disconnects after success and after a disconnect failure does not replace a clean result with a credential", async () => {
    const events: string[] = [];
    const result = await run({ openPrisma: fakeOpen(events, []) });
    assert.equal(result.liveEvidence, "not-attested");
    assert.deepEqual(events, ["open", "transaction", "disconnect"]);
    const closeEvents: string[] = [];
    await assert.rejects(
      () => run({ openPrisma: fakeOpen(closeEvents, [], { failDisconnect: new Error(`end ${SECRET}`) }) }),
      (error: unknown) => {
        assert.match((error as Error).message, /phase CLIENT_DISCONNECT category unclassified/);
        assert.doesNotMatch((error as Error).message, new RegExp(SECRET));
        return true;
      },
    );
    assert.equal(closeEvents.at(-1), "disconnect");
  });

  it("classifies setup, catalog, and cleanup failures without leaking driver text or granting authority", async () => {
    const setup = Object.assign(new Error("postgresql://role:secret@host/neondb SET TRANSACTION"), { code: "25001" });
    const setupSql: string[] = [];
    await assert.rejects(
      () => run({ openPrisma: fakeOpen([], setupSql, { failExecute: (statement) => statement === SET_TRANSACTION_READ_ONLY_SQL ? setup : undefined }) }),
      (error: unknown) => {
        assert.match((error as Error).message, /phase READ_ONLY_TRANSACTION_SETUP category 25001/);
        assert.doesNotMatch((error as Error).message, /secret|postgres(ql)?:\/\//i);
        assert.doesNotMatch((error as Error).message, /writeAuthority|cleanupAuthorized|loadAuthorized/);
        return true;
      },
    );
    assert.equal(setupSql.includes("SELECT count(*) FROM public.sessions"), false);

    const catalogEvents: string[] = [];
    const catalogError = Object.assign(new Error("password=hidden"), { meta: { driverAdapterError: { cause: { originalCode: "42501" } } } });
    await assert.rejects(
      () => run({ openPrisma: fakeOpen(catalogEvents, [], { failCatalog: catalogError }) }),
      /phase CATALOG_QUERY category 42501/,
    );
    assert.equal(catalogEvents.at(-1), "disconnect");

    const nativeType = Object.assign(new Error("raw query failed postgresql://role:secret@host/neondb"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { kind: "UnsupportedNativeDataType", type: "name", originalMessage: "secret" } } },
    });
    await assert.rejects(
      () => run({ openPrisma: fakeOpen([], [], { failQuery: nativeType }) }),
      (error: unknown) => {
        assert.match((error as Error).message, /phase DATABASE_ROLE_PROOF category nativetype/);
        assert.doesNotMatch((error as Error).message, /secret|postgres(ql)?:\/\/|name/);
        return true;
      },
    );

    const cleanup = new Error("rollback postgresql://role:secret@host/neondb");
    await assert.rejects(
      () => run({ openPrisma: fakeOpen([], [], { failExecute: (statement) => statement === "ROLLBACK" ? cleanup : undefined }) }),
      (error: unknown) => {
        assert.match((error as Error).message, /phase TRANSACTION_CLEANUP category unclassified/);
        assert.doesNotMatch((error as Error).message, /secret|postgres(ql)?:\/\//i);
        return true;
      },
    );
  });
});
