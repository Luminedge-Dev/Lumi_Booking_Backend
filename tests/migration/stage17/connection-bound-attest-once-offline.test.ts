import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST } from "../../../scripts/migration/stage17/allowlist";
import { main } from "../../../scripts/migration/stage17/connection-bound-attest-once";
import { ATTESTOR_ROLE, type OpenAttestorPrisma } from "../../../scripts/migration/stage17/connection-bound-attestor";
import type { NeonApiFetch } from "../../../scripts/migration/stage17/neon-api-transport";
import { OPERATOR_OBSERVED } from "../../../scripts/migration/stage17/neon-discover-once";
import { PREFLIGHT_CHILD_ENDPOINT_ID } from "../../../scripts/migration/stage17/readonly-preflight";
import { READ_ONLY_PROOF_SQL } from "../../../scripts/migration/stage17/readonly-session-contract";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/connection-bound-attest-once.ts"), "utf8");
const SECRET = "secret-password";
const NOW = "2026-10-11T06:00:00.000Z";

function url(endpoint: string, pooled = false): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://${ATTESTOR_ROLE}:${SECRET}@${host}/neondb`;
}

function page(body: unknown) {
  return { status: 200, headers: { get: () => null }, json: async () => body };
}

function fetchImpl(): NeonApiFetch {
  return async (request) => {
    if (request.method !== "GET" || request.redirect !== "error") throw new Error("write method");
    if (request.url.pathname.endsWith("/branches")) {
      return page({
        branches: [
          { id: OPERATOR_OBSERVED.productionBranchId, name: "production", parent_id: null },
          { id: OPERATOR_OBSERVED.parentBranchId, name: "stage13-dev", parent_id: OPERATOR_OBSERVED.productionBranchId },
          { id: OPERATOR_OBSERVED.childBranchId, name: OPERATOR_OBSERVED.childName, parent_id: OPERATOR_OBSERVED.parentBranchId },
        ],
        pagination: { sort_order: "desc" },
      });
    }
    if (request.url.pathname.endsWith("/endpoints")) {
      return page({
        endpoints: [
          { id: OPERATOR_OBSERVED.parentEndpointId, branch_id: OPERATOR_OBSERVED.parentBranchId },
          { id: OPERATOR_OBSERVED.childEndpointId, branch_id: OPERATOR_OBSERVED.childBranchId },
        ],
      });
    }
    return page({ project: { id: OPERATOR_OBSERVED.projectId } });
  };
}

function openPrisma(): OpenAttestorPrisma {
  return async () => {
    const token = {};
    return {
      token,
      async runReadOnly(work) {
        await work({
          token,
          async execute() {},
          async query(statement) {
            if (statement === READ_ONLY_PROOF_SQL) {
              return { rows: [{ transaction_read_only: "on", role_name: ATTESTOR_ROLE, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false }] };
            }
            if (statement.startsWith("SELECT current_database()")) return { rows: [{ current_database: "neondb" }] };
            if (statement.startsWith("SELECT n.nspname")) return { rows: CLEANUP_ALLOWLIST.map((relname) => ({ nspname: "public", relname })) };
            if (statement.startsWith("SELECT src_ns.nspname")) {
              return { rows: [{ referencing_schema: "public", referencing_table: "sessions", referenced_schema: "public", referenced_table: "users" }] };
            }
            if (statement.startsWith("SELECT count(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
          },
        });
      },
      async disconnect() {},
    };
  };
}

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("stage17 connection-bound attest once", () => {
  it("does not read application database configuration", () => {
    assert.doesNotMatch(SOURCE, /getPrismaClient|NEON_DB_URL|NEON_DIRECT_URL|MONGODB_URI|dotenv|authorizeCleanupExecution/);
    assert.match(SOURCE, /STAGE17_NEON_API_TOKEN/);
    assert.match(SOURCE, /STAGE17_PREFLIGHT_POOLED_URL/);
    assert.match(SOURCE, /STAGE17_PREFLIGHT_DIRECT_URL/);
  });

  it("stops before any client when arguments or inputs are missing", async () => {
    const extra = await capture(() => main({ STAGE17_NEON_API_TOKEN: "t", STAGE17_PREFLIGHT_POOLED_URL: "u", STAGE17_PREFLIGHT_DIRECT_URL: "d" }, ["node", "script", "extra"]));
    assert.equal(extra.code, 1);
    assert.match(extra.stderr, /unexpected arguments/);
    const absent = await capture(() => main({}, ["node", "script"]));
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /an attestation input is absent/);
    assert.equal(absent.stdout, "");
  });

  it("writes a sanitized fixture report and does not treat it as live authorization", async () => {
    const result = await capture(() => main({
      STAGE17_NEON_API_TOKEN: "fixture-token",
      STAGE17_PREFLIGHT_POOLED_URL: url(PREFLIGHT_CHILD_ENDPOINT_ID, true),
      STAGE17_PREFLIGHT_DIRECT_URL: url(PREFLIGHT_CHILD_ENDPOINT_ID),
    }, ["node", "script"], {
      fetchImpl: fetchImpl(),
      openPrisma: openPrisma(),
      clock: () => NOW,
    }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /connectionBoundChecks: passed/);
    assert.match(result.stdout, /liveEvidence: not-attested/);
    assert.match(result.stdout, /apiAttestation: not-approved/);
    assert.match(result.stdout, /writeAuthority: none/);
    assert.match(result.stdout, /cleanupAuthorized: false/);
    assert.match(result.stdout, /loadAuthorized: false/);
    assert.match(result.stdout, /productionWriteAuthority: none/);
    assert.doesNotMatch(result.stdout, new RegExp(SECRET));
    assert.doesNotMatch(result.stdout, /fixture-token|postgres(ql)?:\/\//i);
    assert.equal(result.stderr, "");
  });

  it("keeps a Neon API 401 as an API credential failure", async () => {
    const rejected: NeonApiFetch = async () => ({ status: 401, headers: { get: () => null }, json: async () => ({}) });
    const result = await capture(() => main({
      STAGE17_NEON_API_TOKEN: "fixture-token",
      STAGE17_PREFLIGHT_POOLED_URL: url(PREFLIGHT_CHILD_ENDPOINT_ID, true),
      STAGE17_PREFLIGHT_DIRECT_URL: url(PREFLIGHT_CHILD_ENDPOINT_ID),
    }, ["node", "script"], {
      fetchImpl: rejected,
      openPrisma: openPrisma(),
      clock: () => NOW,
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /STOP: Neon API project request failed status 401 credential rejected/);
    assert.doesNotMatch(result.stderr, /PostgreSQL driver failed/);
    assert.equal(result.stdout, "");
  });
});
