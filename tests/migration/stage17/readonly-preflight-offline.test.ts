import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST, authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import { PREFLIGHT_CHILD_ENDPOINT_ID, reviewReadOnlyPreflight, type PreflightCatalog } from "../../../scripts/migration/stage17/readonly-preflight";

const CHILD = PREFLIGHT_CHILD_ENDPOINT_ID;
const SECRET = "secret-password";

function url(endpoint: string, database = "neondb", pooled = false): string {
  const host = pooled ? `${endpoint}-pooler.region.neon.tech` : `${endpoint}.region.neon.tech`;
  return `postgresql://role:${SECRET}@${host}/${database}`;
}

function catalog(patch: Partial<PreflightCatalog> = {}): PreflightCatalog {
  return {
    databaseName: "neondb",
    publicTables: [...CLEANUP_ALLOWLIST],
    foreignKeys: [{ referencingSchema: "public", referencingTable: "sessions", referencedSchema: "public", referencedTable: "users" }],
    sessions: 0,
    accounts: 0,
    verifications: 0,
    ...patch,
  };
}

describe("stage17 read-only preflight", () => {
  it("accepts the child endpoint catalog without approving a connection or a write", async () => {
    let reads = 0;
    const result = await reviewReadOnlyPreflight({
      pooledUrl: url(CHILD, "neondb", true),
      directUrl: url(CHILD),
      readCatalog: () => {
        reads += 1;
        return catalog();
      },
    });
    assert.equal(reads, 1);
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.parentApproval, "PENDING");
    assert.equal(result.apiAttestation, "not-approved");
    assert.equal(result.liveConnection, "catalog-supplied");
    assert.equal(result.urlClassification, "not-connection-proof");
    assert.equal(result.endpointId, CHILD);
    assert.match(result.report, /missingAllowlistTables: none/);
    assert.match(result.report, /identityCounts: sessions 0 accounts 0 verifications 0/);
    assert.match(result.report, /cleanupAuthorized: false/);
    assert.equal(result.report.includes(SECRET), false);
    assert.doesNotMatch(result.report, /postgres(ql)?:\/\//i);
  });

  it("rejects a URL-only review before any catalog read", async () => {
    let reads = 0;
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: undefined,
      }),
      /URL classification is not a live connection/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
      }),
      /URL classification is not a live connection/,
    );
    assert.equal(reads, 0);
  });

  it("rejects the parent endpoint, the production endpoint, a mismatched pair, and the wrong database", async () => {
    let reads = 0;
    const readCatalog = () => {
      reads += 1;
      return catalog();
    };
    await assert.rejects(
      () => reviewReadOnlyPreflight({ pooledUrl: url("ep-rapid-bread-b4gi8ftb", "neondb", true), directUrl: url("ep-rapid-bread-b4gi8ftb"), readCatalog }),
      /stage13-dev is not a rehearsal target/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({ pooledUrl: url("ep-falling-brook-b42o130z", "neondb", true), directUrl: url("ep-falling-brook-b42o130z"), readCatalog }),
      /production endpoint/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({ pooledUrl: url(CHILD, "neondb", true), directUrl: url("ep-other-endpoint"), readCatalog }),
      /pooled and direct endpoints differ/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({ pooledUrl: url(CHILD, "otherdb", true), directUrl: url(CHILD, "otherdb"), readCatalog }),
      /database name is not neondb/,
    );
    assert.equal(reads, 0);
  });

  it("rejects a live database name that disagrees with the URL", async () => {
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({ databaseName: "postgres" }),
      }),
      /current_database\(\) is not neondb/,
    );
  });

  it("rejects a missing allowlist table, an outside foreign key, and a nonzero identity count", async () => {
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({ publicTables: CLEANUP_ALLOWLIST.filter((table) => table !== "bookings") }),
      }),
      /allowlist table is missing/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({ foreignKeys: [{ referencingSchema: "public", referencingTable: "outside_table", referencedSchema: "public", referencedTable: "users" }] }),
      }),
      /foreign-key referencer is outside the cleanup allowlist/,
    );
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({ sessions: 2 }),
      }),
      /identity tables are not empty/,
    );
  });

  it("keeps schema on both sides of a foreign key and rejects another schema with the same table name", async () => {
    await reviewReadOnlyPreflight({
      pooledUrl: url(CHILD, "neondb", true),
      directUrl: url(CHILD),
      readCatalog: () => catalog(),
    });
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({
          foreignKeys: [{ referencingSchema: "archive", referencingTable: "sessions", referencedSchema: "public", referencedTable: "users" }],
        }),
      }),
      /foreign-key referencer is outside the cleanup allowlist/,
    );
    await reviewReadOnlyPreflight({
      pooledUrl: url(CHILD, "neondb", true),
      directUrl: url(CHILD),
      readCatalog: () => catalog({
        foreignKeys: [{ referencingSchema: "archive", referencingTable: "sessions", referencedSchema: "archive", referencedTable: "users" }],
      }),
    });
    await assert.rejects(
      () => reviewReadOnlyPreflight({
        pooledUrl: url(CHILD, "neondb", true),
        directUrl: url(CHILD),
        readCatalog: () => catalog({
          foreignKeys: [{ referencingSchema: "Archive", referencingTable: "sessions", referencedSchema: "public", referencedTable: "users" }],
        }),
      }),
      /foreign-key schema is malformed/,
    );
    assert.equal(CLEANUP_ALLOWLIST.length, 16);
  });

  it("does not grant cleanup authority and does not read application configuration", async () => {
    assert.throws(() => authorizeCleanupExecution(), /not available/);
    const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/migration/stage17/readonly-preflight.ts"), "utf8");
    assert.doesNotMatch(source, /dotenv|prisma|createPrismaSink|process\.env\.NEON_DB_URL|process\.env\.NEON_DIRECT_URL|process\.env\.MONGODB_URI/);
    assert.match(source, /PREFLIGHT_STATEMENTS/);
    assert.match(source, /referencing_schema/);
    assert.doesNotMatch(source, /regclass/);
    assert.equal(source.includes(SECRET), false);
  });
});
