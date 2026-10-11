import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import { allowsDestructiveRehearsal } from "../../../scripts/migration/stage17/rehearsal-guard";
import { parseStage17Args } from "../../../scripts/migration/stage17/cli";
import {
  LIVE_COLLECTION_COMPLETENESS,
  OPERATOR_APPROVAL_FIELDS,
  discoverNeonMetadata,
  planReadOnlyPreflight,
  renderDiscoveryReport,
  type NeonReadTransport,
} from "../../../scripts/migration/stage17/neon-discovery";
import { runStage17 } from "../../../scripts/migration/stage17/runner";
import { STAGE13_DEV_ENDPOINT_ID } from "../../../scripts/migration/stage17/rehearsal-guard";

const BACKEND = path.resolve(__dirname, "../../../");
const calls = { count: 0 };

function transport(bodies: { project: unknown; branches: unknown; endpoints: unknown }): NeonReadTransport {
  return {
    readProject() {
      calls.count += 1;
      return bodies.project;
    },
    readBranches() {
      calls.count += 1;
      return bodies.branches;
    },
    readEndpoints() {
      calls.count += 1;
      return bodies.endpoints;
    },
  };
}

function fixture(patch: { projectId?: string; child?: boolean; endpoints?: unknown; branches?: unknown } = {}) {
  const projectId = patch.projectId ?? "proj-test";
  const branches = patch.branches ?? {
    branches: [
      { id: "br-parent", name: "stage13-dev", parent_id: "br-root" },
      ...(patch.child === false ? [] : [{ id: "br-child", name: "stage17-rehearsal-test", parent_id: "br-parent" }]),
    ],
  };
  const endpoints = patch.endpoints ?? {
    endpoints: [
      { id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-parent", host: `${STAGE13_DEV_ENDPOINT_ID}.region.neon.tech` },
      ...(patch.child === false ? [] : [{ id: "ep-rehearsal-test", branch_id: "br-child", host: "ep-rehearsal-test.region.neon.tech" }]),
    ],
  };
  return { project: { project: { id: projectId, name: "luminedge" } }, branches, endpoints };
}

const approved = { projectId: "proj-test", parentBranchId: "br-parent", childBranchName: "stage17-rehearsal-test" };

function mapping(endpoint = "ep-rehearsal-test", owner = "br-child") {
  return {
    pooledUrl: `postgresql://role:secret@${endpoint}-pooler.region.neon.tech/neondb`,
    directUrl: `postgresql://role:secret@${endpoint}.region.neon.tech/neondb`,
    ownerBranchId: owner,
  };
}

describe("Stage 17 F2 Neon discovery", () => {
  it("accepts valid project, parent, and child metadata without write authority", async () => {
    calls.count = 0;
    const evidence = await discoverNeonMetadata({ transport: transport(fixture()), approved, endpointMapping: mapping() });
    assert.equal(calls.count, 3);
    assert.equal(evidence.writeAuthority, "none");
    assert.equal(evidence.projectStatus, "matches-approved");
    assert.equal(evidence.parent.name, "stage13-dev");
    assert.equal(evidence.parentStatus, "matches-approved");
    assert.equal(evidence.child.status, "present");
    assert.equal(evidence.createsBranch, false);
    assert.equal(evidence.endpoints.find((row) => row.role === "child")?.branchId, "br-child");
    const report = renderDiscoveryReport(evidence);
    assert.match(report, /writeAuthority: none/);
    assert.doesNotMatch(report, /secret|postgresql:\/\//);
    assert.equal(evidence.pendingApproval.includes("API credential permitted to read branch metadata"), true);
  });

  it("rejects the wrong project and a missing or incorrect parent", async () => {
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture({ projectId: "proj-other" })), approved }), /approved project/);
    const missingParent = fixture();
    missingParent.branches = { branches: [{ id: "br-child", name: "stage17-rehearsal-test", parent_id: null }] };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(missingParent), approved }), /parent branch stage13-dev is missing/);
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture()), approved: { ...approved, parentBranchId: "br-other" } }), /approved parent/);
  });

  it("records a missing child without inventing one and rejects a child that is the parent", async () => {
    const before = calls.count;
    const absent = await discoverNeonMetadata({
      transport: transport(fixture({ child: false })),
      approved: { projectId: "proj-test", parentBranchId: "br-parent", childBranchName: "stage17-rehearsal-test" },
    });
    assert.equal(absent.child.status, "absent");
    assert.equal(Object.hasOwn(absent.child, "id"), false);
    assert.equal(absent.pendingApproval.includes("rehearsal child branch id"), true);
    assert.equal(absent.pendingApproval.includes("rehearsal endpoint id"), true);
    assert.equal(absent.writeAuthority, "none");
    assert.equal(calls.count, before + 3);
    const plan = planReadOnlyPreflight(false);
    assert.equal(plan.childEndpointRequired, false);
    assert.equal(plan.createsBranch, false);
    assert.equal(plan.writeAuthority, "none");
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: fixture().project,
          branches: { branches: [{ id: "br-parent", name: "stage13-dev", parent_id: null }, { id: "br-parent", name: "stage17-rehearsal-test", parent_id: "br-parent" }] },
          endpoints: { endpoints: [] },
        }),
        approved,
      }),
      /branch id is duplicated/,
    );
  });

  it("rejects wrong ownership, a parent endpoint used as a child, and a production endpoint", async () => {
    const lookalike = fixture();
    lookalike.endpoints = { endpoints: [{ id: "ep-rehearsal-test", branch_id: "br-parent", host: "ep-rehearsal-test.region.neon.tech" }] };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(lookalike), approved, endpointMapping: mapping() }), /endpoint ownership/);
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture()), approved, endpointMapping: mapping(STAGE13_DEV_ENDPOINT_ID) }), /parent endpoint was presented as a child endpoint/);
    const production = fixture();
    production.endpoints = {
      endpoints: [
        { id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-parent" },
        { id: "ep-falling-brook-9", branch_id: "br-child" },
      ],
    };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(production), approved }), /production endpoint/);
    const onParent = fixture();
    onParent.branches = {
      branches: [
        { id: "br-prod", name: "production", parent_id: null },
        { id: "br-parent", name: "stage13-dev", parent_id: "br-prod" },
        { id: "br-child", name: "stage17-rehearsal-test", parent_id: "br-parent" },
      ],
    };
    onParent.endpoints = { endpoints: [{ id: "ep-falling-brook-9", branch_id: "br-parent" }] };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(onParent), approved }), /not owned by the production branch/);
  });

  it("keeps a production-owned endpoint in read-only metadata without write authority", async () => {
    const bodies = fixture();
    bodies.branches = {
      branches: [
        { id: "br-prod", name: "production", parent_id: null },
        { id: "br-parent", name: "stage13-dev", parent_id: "br-prod" },
        { id: "br-child", name: "stage17-rehearsal-test", parent_id: "br-parent" },
      ],
    };
    bodies.endpoints = {
      endpoints: [
        { id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-parent" },
        { id: "ep-rehearsal-test", branch_id: "br-child" },
        { id: "ep-falling-brook-9", branch_id: "br-prod" },
      ],
    };
    const evidence = await discoverNeonMetadata({ transport: transport(bodies), approved });
    const production = evidence.endpoints.find((row) => row.endpointId === "ep-falling-brook-9");
    assert.equal(production?.role, "other");
    assert.equal(production?.branchId, "br-prod");
    assert.equal(evidence.endpoints.find((row) => row.role === "child")?.endpointId, "ep-rehearsal-test");
    assert.equal(evidence.writeAuthority, "none");
    assert.equal(evidence.createsBranch, false);
  });

  it("rejects malformed responses and duplicate endpoint mappings", async () => {
    await assert.rejects(() => discoverNeonMetadata({ transport: transport({ ...fixture(), project: { project: {} } }), approved }), /incomplete/);
    await assert.rejects(() => discoverNeonMetadata({ transport: transport({ ...fixture(), branches: { branches: "nope" } }), approved }), /incomplete/);
    await assert.rejects(() => discoverNeonMetadata({ transport: transport({ ...fixture(), endpoints: { endpoints: [{ id: "ep-rehearsal-test" }] } }), approved }), /incomplete/);
    const duplicated = fixture();
    duplicated.endpoints = { endpoints: [{ id: "ep-rehearsal-test", branch_id: "br-child" }, { id: "ep-rehearsal-test", branch_id: "br-parent" }] };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(duplicated), approved }), /duplicated/);
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport(fixture()),
        approved,
        endpointMapping: { ...mapping(), directUrl: "postgresql://role:secret@ep-other.region.neon.tech/neondb" },
      }),
      /pooled and direct endpoints differ/,
    );
  });

  it("rejects a pooled or direct URL that does not select neondb", async () => {
    const pooledWrong = { ...mapping(), pooledUrl: "postgresql://role:secret@ep-rehearsal-test-pooler.region.neon.tech/otherdb" };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture()), approved, endpointMapping: pooledWrong }), /pooled URL database is not neondb/);
    const directWrong = { ...mapping(), directUrl: "postgresql://role:secret@ep-rehearsal-test.region.neon.tech/otherdb" };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture()), approved, endpointMapping: directWrong }), /direct URL database is not neondb/);
    const bothWrong = {
      ...mapping(),
      pooledUrl: "postgresql://role:secret@ep-rehearsal-test-pooler.region.neon.tech/otherdb",
      directUrl: "postgresql://role:secret@ep-rehearsal-test.region.neon.tech/anotherdb",
    };
    await assert.rejects(() => discoverNeonMetadata({ transport: transport(fixture()), approved, endpointMapping: bothWrong }), /pooled URL database is not neondb/);
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport(fixture()),
        approved,
        endpointMapping: { ...mapping(), pooledUrl: "postgresql://role:secret@db.example.com/neondb" },
      }),
      /Neon PostgreSQL/,
    );
  });

  it("rejects duplicate branch ids and missing branch parent metadata", async () => {
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: fixture().project,
          branches: { branches: [{ id: "br-parent", name: "stage13-dev", parent_id: null }, { id: "br-parent", name: "other", parent_id: null }] },
          endpoints: { endpoints: [] },
        }),
        approved: { projectId: "proj-test", parentBranchId: "br-parent" },
      }),
      /branch id is duplicated/,
    );
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: fixture().project,
          branches: { branches: [{ id: "br-parent", name: "stage13-dev" }] },
          endpoints: { endpoints: [] },
        }),
        approved: { projectId: "proj-test" },
      }),
      /stage13-dev parent_id is missing/,
    );
    assert.equal(LIVE_COLLECTION_COMPLETENESS.status, "documented-contract");
    assert.equal(LIVE_COLLECTION_COMPLETENESS.branchPageLimitMaximum, 10000);
    assert.match(LIVE_COLLECTION_COMPLETENESS.endpoints, /no cursor or limit/);
  });

  it("accepts an omitted or null parent_id only on the single root branch", async () => {
    const endpoints = {
      endpoints: [
        { id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-super-haze-b4rhy28d" },
        { id: "ep-dark-brook-b4atip73", branch_id: "br-shy-rain-b4f301ml" },
      ],
    };
    const approvedHierarchy = { projectId: "still-fog-96300663", childBranchName: "stage17-rehearsal" };
    function hierarchy(production: Record<string, unknown>) {
      return {
        project: { project: { id: "still-fog-96300663" } },
        branches: {
          branches: [
            production,
            { id: "br-super-haze-b4rhy28d", name: "stage13-dev", parent_id: "br-old-bar-b4700916" },
            { id: "br-shy-rain-b4f301ml", name: "stage17-rehearsal", parent_id: "br-super-haze-b4rhy28d" },
          ],
        },
        endpoints,
      };
    }
    const omitted = await discoverNeonMetadata({
      transport: transport(hierarchy({ id: "br-old-bar-b4700916", name: "production" })),
      approved: approvedHierarchy,
    });
    assert.equal(omitted.parent.id, "br-super-haze-b4rhy28d");
    assert.equal(omitted.parent.parentId, "br-old-bar-b4700916");
    assert.equal(omitted.child.status, "present");
    if (omitted.child.status === "present") assert.equal(omitted.child.parentId, "br-super-haze-b4rhy28d");
    assert.equal(omitted.writeAuthority, "none");
    const explicitNull = await discoverNeonMetadata({
      transport: transport(hierarchy({ id: "br-old-bar-b4700916", name: "production", parent_id: null })),
      approved: approvedHierarchy,
    });
    assert.equal(explicitNull.parent.parentId, "br-old-bar-b4700916");
    assert.equal(explicitNull.writeAuthority, "none");
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: { project: { id: "still-fog-96300663" } },
          branches: { branches: [{ id: "br-super-haze-b4rhy28d", name: "stage13-dev" }] },
          endpoints: { endpoints: [] },
        }),
        approved: approvedHierarchy,
      }),
      /stage13-dev parent_id is missing/,
    );
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: { project: { id: "still-fog-96300663" } },
          branches: {
            branches: [
              { id: "br-old-bar-b4700916", name: "production" },
              { id: "br-super-haze-b4rhy28d", name: "stage13-dev", parent_id: "br-old-bar-b4700916" },
              { id: "br-shy-rain-b4f301ml", name: "stage17-rehearsal" },
            ],
          },
          endpoints: { endpoints: [] },
        }),
        approved: approvedHierarchy,
      }),
      /rehearsal child parent_id is missing/,
    );
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: { project: { id: "still-fog-96300663" } },
          branches: {
            branches: [
              { id: "br-old-bar-b4700916", name: "production", parent_id: null },
              { id: "br-super-haze-b4rhy28d", name: "stage13-dev", parent_id: "br-old-bar-b4700916" },
              { id: "br-shy-rain-b4f301ml", name: "stage17-rehearsal", parent_id: "br-other" },
            ],
          },
          endpoints,
        }),
        approved: approvedHierarchy,
      }),
      /child branch parent does not match stage13-dev/,
    );
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: transport({
          project: { project: { id: "still-fog-96300663" } },
          branches: { branches: [{ id: "br-old-bar-b4700916", name: "production", parent_id: 12 }] },
          endpoints: { endpoints: [] },
        }),
        approved: approvedHierarchy,
      }),
      /branch parent_id is malformed/,
    );
  });

  it("refuses a fabricated live-preflight claim and performs no HTTP from the module", async () => {
    const claimed = await discoverNeonMetadata({ transport: transport(fixture({ child: false })), approved: { projectId: "proj-test" }, origin: "live-preflight" });
    assert.equal(claimed.writeAuthority, "none");
    assert.equal(claimed.projectStatus, "matches-approved");
    assert.equal(claimed.child.status, "absent");
    const text = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage17/neon-discovery.ts"), "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(|http\.request|https\.request|XMLHttpRequest|createPrismaSink|getPrismaClient|PrismaClient/);
    assert.equal(OPERATOR_APPROVAL_FIELDS.includes("Neon project id"), true);
    assert.throws(() => parseStage17Args(["load"]), /mode must be/);
    assert.throws(() => parseStage17Args(["cleanup"]), /mode must be/);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
    assert.equal(allowsDestructiveRehearsal(), false);
    await assert.rejects(() => runStage17(["dry-run", "--run-id", "offline"]), /not authorized/);
    const guards = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage14/guards.ts"), "utf8");
    assert.match(guards, /ep-rapid-bread-b4gi8ftb/);
  });
});
