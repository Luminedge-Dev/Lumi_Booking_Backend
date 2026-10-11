import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import {
  ATTESTATION_MAX_AGE_MS,
  LIVE_ATTESTATION_REQUIREMENTS,
  claimLivePreflight,
  describeConstructedConnection,
  evaluateInjectedProbe,
  authorizeBranchCreate,
  authorizeLoadExecution,
  authorizeReconcileWrite,
  isLiveNeonApiResponse,
  isLiveWriteCapability,
  mintLiveCapability,
  rejectUrlOnlyBranchProof,
  requireCleanupScope,
  requireLoadScope,
  revalidateAttestation,
  reviewCleanupScope,
  reviewLoadScope,
  simulateOfflineAuthorization,
  validateStructuralIdentity,
  type ApiEndpointMapping,
  type InjectedProbeInput,
} from "../../../scripts/migration/stage17/attestation";
import { parseStage17Args } from "../../../scripts/migration/stage17/cli";
import { allowsDestructiveRehearsal, STAGE13_DEV_ENDPOINT_ID, type ApprovedRehearsalIdentity, type RehearsalBranchMetadata } from "../../../scripts/migration/stage17/rehearsal-guard";
import { runStage17 } from "../../../scripts/migration/stage17/runner";

const BACKEND = path.resolve(__dirname, "../../../");
const NOW = "2026-10-09T04:00:00.000Z";
const FRESH = "2026-10-09T03:59:00.000Z";

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

function urls(endpoint = "ep-rehearsal-test", database = "neondb"): { pooledUrl: string; directUrl: string } {
  return {
    pooledUrl: `postgresql://role:secret@${endpoint}-pooler.region.neon.tech/${database}`,
    directUrl: `postgresql://role:secret@${endpoint}.region.neon.tech/${database}`,
  };
}

function structural(patch: Partial<RehearsalBranchMetadata> = {}, endpoint = approved.endpointId) {
  return validateStructuralIdentity({
    acknowledgement: "stage17-rehearsal",
    ...urls(endpoint),
    approved: { ...approved, endpointId: endpoint },
    metadata: metadata({ ...patch, endpointIds: [endpoint] }),
  });
}

function mapping(patch: Partial<ApiEndpointMapping> = {}): ApiEndpointMapping {
  return {
    projectId: approved.projectId,
    parentBranchId: approved.parentBranchId,
    parentBranchName: "stage13-dev",
    childBranchId: "br-child",
    childBranchName: approved.childBranchName,
    endpointIds: [approved.endpointId],
    observedAt: FRESH,
    ...patch,
  };
}

function probeInput(patch: Partial<InjectedProbeInput> = {}): InjectedProbeInput {
  const client = { token: {} };
  const base: InjectedProbeInput = {
    structural: structural(),
    mapping: mapping(),
    datasource: urls(),
    client,
    probe: { through: client.token, endpointId: approved.endpointId, currentDatabase: "neondb", observedAt: FRESH },
    referencers: [{ referencingTable: "sessions", referencedTable: "users" }],
    identity: { sessions: 0, accounts: 0, verifications: 0 },
    now: NOW,
  };
  return { ...base, ...patch };
}

describe("Stage 17 F2 offline attestation", () => {
  it("accepts correct fixture metadata as structurally valid and withholds write authority", () => {
    const identity = structural();
    assert.equal(identity.structurallyValid, true);
    assert.equal(identity.writeAuthority, "none");
    assert.equal(identity.databaseName, "neondb");
    assert.equal(identity.facts.authority, "none");
    assert.equal(identity.parentBranchName, "stage13-dev");
    assert.notEqual(identity.childBranchId, identity.parentBranchId);
    const review = evaluateInjectedProbe(probeInput({ structural: identity }));
    assert.equal(review.liveEvidence, "not-attested");
    assert.equal(review.productionWriteAuthority, "none");
    assert.equal(review.cleanupAuthority, "none");
    assert.equal(review.loadAuthority, "none");
    const simulated = simulateOfflineAuthorization();
    assert.equal(simulated.kind, "offline-simulation");
    assert.equal(simulated.productionWriteAuthority, "none");
    assert.equal(isLiveWriteCapability(simulated), false);
    assert.equal(isLiveNeonApiResponse(mapping()), false);
    assert.equal(LIVE_ATTESTATION_REQUIREMENTS.length, 10);
  });

  it("rejects an incorrect Neon project and an incorrect parent branch", () => {
    assert.throws(() => structural({ projectId: "proj-other" }), /project id/);
    assert.throws(() => structural({ parentBranchId: "br-other" }), /parent branch id/);
    assert.throws(() => structural({ parentBranchName: "main" }), /parent branch/);
  });

  it("rejects a child that is the parent", () => {
    assert.throws(() => structural({ childBranchId: approved.parentBranchId }), /parent and child/);
    assert.throws(() => structural({ childBranchName: "stage13-dev" }), /stage13-dev/);
  });

  it("rejects the stage13-dev endpoint and a production endpoint", () => {
    assert.throws(() => structural({}, STAGE13_DEV_ENDPOINT_ID), /stage13-dev/);
    assert.throws(() => structural({}, "ep-falling-brook-1"), /production/);
  });

  it("rejects a pooled and direct endpoint mismatch and a wrong database name", () => {
    const client = { token: {} };
    const mismatched = {
      pooledUrl: urls().pooledUrl,
      directUrl: "postgresql://role:secret@ep-other.region.neon.tech/neondb",
    };
    assert.throws(() => describeConstructedConnection(client, mismatched), /pooled and direct endpoints differ/);
    assert.throws(() => describeConstructedConnection(client, urls(approved.endpointId, "otherdb")), /database name is not neondb/);
    assert.throws(() => evaluateInjectedProbe(probeInput({ probe: { through: client.token, endpointId: approved.endpointId, currentDatabase: "postgres", observedAt: FRESH }, client })), /database name is not neondb/);
  });

  it("treats two clients with the same connection string as different connections", () => {
    const left = { token: {} };
    const right = { token: {} };
    const datasource = urls();
    const boundLeft = describeConstructedConnection(left, datasource);
    const boundRight = describeConstructedConnection(right, datasource);
    assert.equal(boundLeft.endpointId, boundRight.endpointId);
    assert.equal(boundLeft.authority, "none");
    assert.notEqual(boundLeft.client, boundRight.client);
    assert.throws(
      () => evaluateInjectedProbe(probeInput({ client: left, probe: { through: right.token, endpointId: approved.endpointId, currentDatabase: "neondb", observedAt: FRESH } })),
      /not read through the constructed client/,
    );
    assert.throws(() => rejectUrlOnlyBranchProof({ url: datasource.pooledUrl, currentDatabase: "neondb" }), /do not prove branch identity/);
  });

  it("fails closed when foreign-key metadata is missing or an outside referencer appears", () => {
    assert.throws(() => evaluateInjectedProbe(probeInput({ referencers: null })), /foreign-key metadata is missing/);
    assert.throws(
      () => evaluateInjectedProbe(probeInput({ referencers: [{ referencingTable: "extra", referencedTable: "users" }] })),
      /outside the cleanup allowlist/,
    );
  });

  it("fails closed when a protected identity table is nonzero or the census is missing", () => {
    assert.throws(() => evaluateInjectedProbe(probeInput({ identity: null })), /identity census is missing/);
    assert.throws(() => evaluateInjectedProbe(probeInput({ identity: { sessions: 1, accounts: 0, verifications: 0 } })), /identity tables/);
    assert.throws(() => evaluateInjectedProbe(probeInput({ identity: { sessions: 0, accounts: 2, verifications: 0 } })), /identity tables/);
    assert.throws(() => evaluateInjectedProbe(probeInput({ identity: { sessions: 0, accounts: 0, verifications: 3 } })), /identity tables/);
  });

  it("fails closed on missing or stale attestation evidence and on revalidation drift", () => {
    assert.throws(() => evaluateInjectedProbe(probeInput({ probe: null })), /attestation evidence is missing/);
    assert.throws(() => evaluateInjectedProbe(probeInput({ mapping: null })), /attestation evidence is missing/);
    const stale = new Date(Date.parse(NOW) - ATTESTATION_MAX_AGE_MS - 1).toISOString();
    assert.throws(() => evaluateInjectedProbe(probeInput({ mapping: mapping({ observedAt: stale }) })), /stale/);
    const client = {};
    assert.throws(
      () => revalidateAttestation({
        previous: { observedAt: FRESH, endpointId: approved.endpointId, client },
        next: { observedAt: stale, endpointId: approved.endpointId, client },
        now: NOW,
      }),
      /stale/,
    );
    const other = {};
    assert.throws(
      () => revalidateAttestation({
        previous: { observedAt: FRESH, endpointId: approved.endpointId, client },
        next: { observedAt: FRESH, endpointId: approved.endpointId, client: other },
        now: NOW,
      }),
      /revalidation client/,
    );
    const fresh = revalidateAttestation({
      previous: { observedAt: FRESH, endpointId: approved.endpointId, client },
      next: { observedAt: FRESH, endpointId: approved.endpointId, client },
      now: NOW,
    });
    assert.equal(fresh.authority, "none");
    assert.equal(fresh.fresh, true);
  });

  it("refuses a fabricated live-preflight claim and keeps cleanup and load scopes independent", () => {
    const claimed = { ...mapping(), origin: "live-preflight" };
    assert.equal(isLiveNeonApiResponse(claimed), false);
    assert.throws(() => claimLivePreflight({ origin: "live-preflight" }), /caller-provided origin/);
    const review = evaluateInjectedProbe(probeInput());
    const cleanup = reviewCleanupScope(review);
    const load = reviewLoadScope(review);
    assert.equal(cleanup.authority, "none");
    assert.equal(load.authority, "none");
    assert.throws(() => requireLoadScope(cleanup), /independent of cleanup/);
    assert.throws(() => requireCleanupScope(load), /independent of load/);
    assert.equal(allowsDestructiveRehearsal(), false);
  });

  it("constructs no SQL transaction and no sink, and leaves F1 and Stage 14 closed", async () => {
    const text = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage17/attestation.ts"), "utf8");
    assert.doesNotMatch(text, /\$transaction|TRUNCATE|PrismaClient|getPrismaClient|createPrismaSink|MongoClient|NEON_DB_URL/);
    assert.throws(() => mintLiveCapability(), /not available/);
    assert.throws(() => authorizeLoadExecution(), /not available/);
    assert.throws(() => authorizeBranchCreate(), /not available/);
    assert.throws(() => authorizeReconcileWrite(), /not available/);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
    assert.throws(() => parseStage17Args(["load"]), /mode must be/);
    assert.throws(() => parseStage17Args(["cleanup"]), /mode must be/);
    assert.throws(() => parseStage17Args(["reconcile"]), /mode must be/);
    assert.throws(() => parseStage17Args(["branch-create"]), /mode must be/);
    await assert.rejects(() => runStage17(["dry-run", "--run-id", "offline"]), /not authorized/);
    const guards = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage14/guards.ts"), "utf8");
    assert.match(guards, /ep-rapid-bread-b4gi8ftb/);
    const loader = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage14/load/loader.ts"), "utf8");
    assert.match(loader, /isVerifiedStage13Target/);
  });
});
