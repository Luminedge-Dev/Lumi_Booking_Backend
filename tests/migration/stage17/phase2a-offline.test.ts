import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_ALLOWLIST, assessCleanup, authorizeCleanupExecution, renderAllowlistSql } from "../../../scripts/migration/stage17/allowlist";
import {
  MANIFEST_DIGEST_VERSION,
  MANIFEST_PRODUCTION,
  SOURCE_IDENTITY_DELTA,
  assertGitignoredManifestPath,
  classifyManifestDelta,
  stampExpectationManifest,
  type DigestManifest,
} from "../../../scripts/migration/stage17/manifest-delta";
import {
  STAGE13_DEV_ENDPOINT_ID,
  allowsDestructiveRehearsal,
  isValidatedRehearsalFacts,
  verifyRehearsalTarget,
  type ApprovedRehearsalIdentity,
  type RehearsalBranchMetadata,
  type ValidatedRehearsalFacts,
} from "../../../scripts/migration/stage17/rehearsal-guard";
import { selectSourcePolicy, type ObservedSource } from "../../../scripts/migration/stage17/source-policy";
import { TABLES } from "../../../scripts/migration/stage14/common";

const BACKEND = path.resolve(__dirname, "../../../");
const approved: ApprovedRehearsalIdentity = {
  projectId: "proj-test",
  parentBranchId: "br-parent",
  parentBranchName: "stage13-dev",
  childBranchName: "stage17-rehearsal-test",
  endpointId: "ep-rehearsal-test",
};

function metadata(patch: Partial<RehearsalBranchMetadata> = {}): RehearsalBranchMetadata {
  return {
    projectId: approved.projectId,
    parentBranchId: approved.parentBranchId,
    parentBranchName: "stage13-dev",
    childBranchId: "br-child",
    childBranchName: approved.childBranchName,
    endpointIds: [approved.endpointId],
    ...patch,
  };
}

function urls(endpoint = "ep-rehearsal-test"): { pooledUrl: string; directUrl: string } {
  return {
    pooledUrl: `postgresql://role:secret@${endpoint}-pooler.region.neon.tech/neondb`,
    directUrl: `postgresql://role:secret@${endpoint}.region.neon.tech/neondb`,
  };
}

function facts(): ValidatedRehearsalFacts {
  return verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls(), approved, metadata: metadata() });
}

const emptyIdentity = { sessions: 0, accounts: 0, verifications: 0 };
const knownReferencers = [
  { referencingTable: "sessions", referencedTable: "users" },
  { referencingTable: "accounts", referencedTable: "users" },
];

describe("Stage 17 Phase 2A offline slices", () => {
  it("brands validated facts and rejects a lookalike object", () => {
    const validated = facts();
    assert.equal(isValidatedRehearsalFacts(validated), true);
    assert.equal(validated.authority, "none");
    assert.equal(allowsDestructiveRehearsal(), false);
    const lookalike = { kind: "rehearsal-facts" as const, endpointId: validated.endpointId, authority: "none" as const };
    assert.equal(isValidatedRehearsalFacts(lookalike), false);
    assert.throws(() => assessCleanup({ facts: lookalike as ValidatedRehearsalFacts, referencers: knownReferencers, identity: emptyIdentity }), /validated rehearsal facts/);
  });

  it("rejects fabricated live-preflight metadata as a cleanup grant", () => {
    const fabricated = { ...metadata(), origin: "live-preflight" };
    const validated = verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls(), approved, metadata: fabricated });
    assert.equal(validated.authority, "none");
    assert.equal(allowsDestructiveRehearsal(), false);
    const review = assessCleanup({ facts: validated, referencers: knownReferencers, identity: emptyIdentity });
    assert.equal(review.executionAuthority, "none");
    assert.equal(review.liveEvidence, "not-attested");
    assert.throws(() => authorizeCleanupExecution(), /live Neon attestation/);
    assert.equal(JSON.stringify(validated).includes("live-preflight"), false);
  });

  it("rejects the parent candidate, production fragment, and branch-id collisions", () => {
    assert.throws(() => verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls(STAGE13_DEV_ENDPOINT_ID), approved: { ...approved, endpointId: STAGE13_DEV_ENDPOINT_ID }, metadata: metadata({ endpointIds: [STAGE13_DEV_ENDPOINT_ID] }) }), /stage13-dev/);
    assert.throws(() => verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls("ep-falling-brook-1"), approved: { ...approved, endpointId: "ep-falling-brook-1" }, metadata: metadata({ endpointIds: ["ep-falling-brook-1"] }) }), /production/);
    assert.throws(() => verifyRehearsalTarget({ acknowledgement: "stage13-dev", ...urls(), approved, metadata: metadata() }), /acknowledgement/);
    assert.throws(() => verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls(), approved, metadata: metadata({ childBranchId: approved.parentBranchId }) }), /parent and child/);
    assert.throws(() => verifyRehearsalTarget({ acknowledgement: "stage17-rehearsal", ...urls(), approved, metadata: metadata({ endpointIds: ["ep-other"] }) }), /does not list/);
    assert.equal(fs.readFileSync(path.join(BACKEND, "scripts/migration/stage14/guards.ts"), "utf8").includes(STAGE13_DEV_ENDPOINT_ID), true);
  });

  it("previews the fixed truncate and refuses identity rows, unknown referencers, and execution", () => {
    const statement = renderAllowlistSql();
    assert.equal(statement.tables.length, 16);
    assert.deepEqual([...statement.tables], [...CLEANUP_ALLOWLIST]);
    assert.match(statement.sql, /^TRUNCATE TABLE public\.sessions, public\.accounts, public\.verifications, public\.users,/);
    assert.match(statement.sql, /public\.bookings$/);
    assert.doesNotMatch(statement.sql, /\bCASCADE\b|\bDROP\b/i);
    const review = assessCleanup({ facts: facts(), referencers: knownReferencers, identity: emptyIdentity });
    assert.equal(review.statementPreview, statement.sql);
    assert.equal(review.executionAuthority, "none");
    assert.throws(() => assessCleanup({ facts: facts(), referencers: knownReferencers, identity: { ...emptyIdentity, sessions: 1 } }), /identity tables/);
    assert.throws(() => assessCleanup({ facts: facts(), referencers: [...knownReferencers, { referencingTable: "extra", referencedTable: "users" }], identity: emptyIdentity }), /outside the cleanup allowlist/);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
  });

  it("classifies canonical-row changes even when counts match, without returning ids", () => {
    const earlier: DigestManifest = {
      digestVersion: MANIFEST_DIGEST_VERSION,
      tables: { users: { a: "digest-a", b: "digest-b" }, bookings: { b1: "same" } },
    };
    const later: DigestManifest = {
      digestVersion: MANIFEST_DIGEST_VERSION,
      tables: { users: { a: "digest-a", c: "digest-c" }, bookings: { b1: "changed" } },
    };
    const report = classifyManifestDelta(earlier, later);
    assert.equal(report.comparison, "canonical-rows");
    assert.equal(report.canonicalRowsAdded, 1);
    assert.equal(report.canonicalRowsAbsent, 1);
    assert.equal(report.canonicalRowsUpdated, 1);
    assert.equal(report.canonicalRowsUnchanged, 1);
    assert.equal(Object.hasOwn(report, "deleted"), false);
    assert.equal(JSON.stringify(report).includes("digest-a"), false);
    assert.equal(JSON.stringify(report).includes("\"a\""), false);
    const users = report.tables.find((table) => table.table === "users");
    assert.equal(users?.canonicalRowsAdded, 1);
    assert.equal(users?.canonicalRowsAbsent, 1);
    assert.equal(earlier.tables.users && Object.keys(earlier.tables.users).length, 2);
    assert.equal(later.tables.users && Object.keys(later.tables.users).length, 2);
    assert.throws(() => classifyManifestDelta({ ...earlier, digestVersion: "other" as typeof MANIFEST_DIGEST_VERSION }, later));
    const stamped = stampExpectationManifest({ ...Object.fromEntries(TABLES.map((table) => [table, {}])) } as DigestManifest["tables"] & Record<(typeof TABLES)[number], Record<string, string>>);
    assert.equal(stamped.digestVersion, MANIFEST_DIGEST_VERSION);
    assert.equal(MANIFEST_PRODUCTION.status, "not-executed-in-slice-c");
    assert.equal(MANIFEST_PRODUCTION.comparison, "canonical-rows");
    assert.doesNotThrow(() => assertGitignoredManifestPath("_migration/stage17-manifests/local.json"));
    assert.throws(() => assertGitignoredManifestPath("context/evidence/manifest.json"));
  });

  it("treats a row that leaves the canonical manifest as absent, not as a MongoDB deletion", () => {
    const accepted: DigestManifest = { digestVersion: MANIFEST_DIGEST_VERSION, tables: { users: { kept: "same", moved: "row" } } };
    const quarantinedLater: DigestManifest = { digestVersion: MANIFEST_DIGEST_VERSION, tables: { users: { kept: "same" } } };
    const report = classifyManifestDelta(accepted, quarantinedLater);
    assert.equal(report.comparison, "canonical-rows");
    assert.equal(report.canonicalRowsAbsent, 1);
    assert.equal(report.canonicalRowsUnchanged, 1);
    assert.match(report.interpretation, /not a confirmed MongoDB deletion/);
    assert.equal(Object.hasOwn(report, "deleted"), false);
    assert.equal(SOURCE_IDENTITY_DELTA.status, "implemented");
    assert.equal(SOURCE_IDENTITY_DELTA.digestVersion, "source-identity-v1");
    assert.deepEqual([...SOURCE_IDENTITY_DELTA.sourceChanges], ["added", "modified", "deleted", "unchanged"]);
    assert.deepEqual([...SOURCE_IDENTITY_DELTA.transformOutcomes], ["accepted", "root-quarantined"]);
  });

  it("selects the local snapshot and a fresh profile without reading the application URI", () => {
    const localUri = "mongodb://reader:secret@127.0.0.1:27017/admin";
    const observed: ObservedSource = {
      host: "127.0.0.1",
      port: "27017",
      username: "reader",
      databaseName: "luminedge_stage17_snapshot_20261008",
      authenticatedUsers: [{ user: "reader", db: "admin" }],
      actions: ["find", "listCollections"],
    };
    const selected = selectSourcePolicy({ policy: "LOCAL_SNAPSHOT", env: { STAGE17_LOCAL_MONGODB_URI: localUri }, observed });
    assert.equal(selected.databaseName, "luminedge_stage17_snapshot_20261008");
    assert.equal(JSON.stringify(selected).includes("secret"), false);
    const applicationKey = ["MONGODB", "URI"].join("_");
    assert.throws(() => selectSourcePolicy({ policy: "LOCAL_SNAPSHOT", env: { [applicationKey]: localUri }, observed }));
    const fresh = { host: "127.0.0.1", port: "27017", databaseName: "luminedge_fresh_copy", username: "reader" };
    const freshObserved: ObservedSource = { ...observed, databaseName: fresh.databaseName };
    const freshSelected = selectSourcePolicy({
      policy: "FUTURE_FRESH_SOURCE",
      env: { STAGE17_SOURCE_MONGODB_URI: localUri },
      observed: freshObserved,
      fresh,
    });
    assert.equal(freshSelected.databaseName, "luminedge_fresh_copy");
    assert.throws(() => selectSourcePolicy({ policy: "FUTURE_FRESH_SOURCE", env: { STAGE17_SOURCE_MONGODB_URI: localUri }, observed: freshObserved, fresh: { ...fresh, host: "10.0.0.8" } }));
    assert.throws(() => selectSourcePolicy({ policy: "FUTURE_FRESH_SOURCE", env: { STAGE17_SOURCE_MONGODB_URI: localUri }, observed: { ...freshObserved, actions: ["find", "insert"] }, fresh }));
    assert.throws(() => selectSourcePolicy({ policy: "FUTURE_FRESH_SOURCE", env: { STAGE17_SOURCE_MONGODB_URI: localUri }, observed, fresh: { ...fresh, databaseName: observed.databaseName } }));
  });

  it("keeps the new modules off the Stage 14 CLI and application config", () => {
    for (const name of ["rehearsal-guard.ts", "allowlist.ts", "manifest-delta.ts", "source-policy.ts"]) {
      const text = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage17", name), "utf8");
      assert.doesNotMatch(text, /from ["'][^"']*stage14\/runner|from ["'][^"']*stage14\/config|from ["'][^"']*\/guards|dotenv|createPrismaSink|process\.env\.MONGODB_URI/);
    }
  });
});
