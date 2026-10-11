import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { NeonApiFetch, NeonApiRequest } from "../../../scripts/migration/stage17/neon-api-transport";
import type { NeonDiscoveryEvidence } from "../../../scripts/migration/stage17/neon-discovery";
import { compareObservedIdentities, executeDiscovery, OPERATOR_OBSERVED } from "../../../scripts/migration/stage17/neon-discover-once";

const SCRIPT = path.resolve(__dirname, "../../../scripts/migration/stage17/neon-discover-once.ts");

function evidence(overrides: Partial<NeonDiscoveryEvidence> = {}): NeonDiscoveryEvidence {
  return {
    kind: "neon-read-evidence",
    writeAuthority: "none",
    observedProjectId: OPERATOR_OBSERVED.projectId,
    projectStatus: "matches-approved",
    parent: { id: OPERATOR_OBSERVED.parentBranchId, name: "stage13-dev", parentId: OPERATOR_OBSERVED.productionBranchId },
    parentStatus: "pending-operator-approval",
    child: { status: "present", id: OPERATOR_OBSERVED.childBranchId, name: OPERATOR_OBSERVED.childName, parentId: OPERATOR_OBSERVED.parentBranchId },
    endpoints: [
      { endpointId: OPERATOR_OBSERVED.parentEndpointId, branchId: OPERATOR_OBSERVED.parentBranchId, role: "parent" },
      { endpointId: OPERATOR_OBSERVED.childEndpointId, branchId: OPERATOR_OBSERVED.childBranchId, role: "child" },
    ],
    pendingApproval: ["stage13-dev branch id"],
    createsBranch: false,
    ...overrides,
  };
}

function page(body: unknown): { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; url?: string } {
  return { status: 200, headers: { get: () => null }, json: async () => body };
}

function projectBranches(extra: { id: string; name: string; parent_id: string | null }[] = []) {
  return {
    branches: [
      { id: OPERATOR_OBSERVED.productionBranchId, name: "production", parent_id: null },
      { id: OPERATOR_OBSERVED.parentBranchId, name: OPERATOR_OBSERVED.parentName, parent_id: OPERATOR_OBSERVED.productionBranchId },
      { id: OPERATOR_OBSERVED.childBranchId, name: OPERATOR_OBSERVED.childName, parent_id: OPERATOR_OBSERVED.parentBranchId },
      ...extra,
    ],
    pagination: { sort_order: "desc" },
  };
}

function matchingFetch(endpoints: { id: string; branch_id: string }[]): { fetchImpl: NeonApiFetch; requests: NeonApiRequest[] } {
  const requests: NeonApiRequest[] = [];
  const fetchImpl: NeonApiFetch = async (request) => {
    requests.push(request);
    if (request.url.pathname.endsWith("/branches")) return page(projectBranches());
    if (request.url.pathname.endsWith("/endpoints")) return page({ endpoints });
    return page({ project: { id: OPERATOR_OBSERVED.projectId } });
  };
  return { fetchImpl, requests };
}

const parentAndChild = [
  { id: OPERATOR_OBSERVED.parentEndpointId, branch_id: OPERATOR_OBSERVED.parentBranchId },
  { id: OPERATOR_OBSERVED.childEndpointId, branch_id: OPERATOR_OBSERVED.childBranchId },
];

describe("stage17 neon discover once", () => {
  it("compares a matching sheet without approving the parent", () => {
    const result = compareObservedIdentities(evidence());
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.createsBranch, false);
    assert.equal(result.parentApproval, "PENDING");
    assert.equal(result.mismatchCount, 0);
    assert.match(result.report, /parentApproval: PENDING/);
    assert.match(result.report, /paginationCompleteness: complete/);
    assert.match(result.report, /childEndpoint: child ep-dark-brook-b4atip73 branch br-shy-rain-b4f301ml/);
    assert.doesNotMatch(result.report, /Bearer |postgres(ql)?:\/\//i);
  });

  it("reports identity mismatches and still withholds approval", () => {
    const result = compareObservedIdentities(evidence({
      parent: { id: "br-other", name: "stage13-dev", parentId: OPERATOR_OBSERVED.productionBranchId },
      parentStatus: "pending-operator-approval",
      child: { status: "absent" },
    }));
    assert.equal(result.parentApproval, "PENDING");
    assert.equal(result.writeAuthority, "none");
    assert.match(result.report, /parent branch mismatch/);
    assert.match(result.report, /child branch is absent/);
    assert.match(result.report, /apiAttestation: not-approved/);
  });

  it("sends only the three GET routes with redirect error and does not print the token", async () => {
    const { fetchImpl, requests } = matchingFetch(parentAndChild);
    const result = await executeDiscovery(fetchImpl, "offline-token");
    assert.equal(result.mismatchCount, 0);
    assert.equal(result.parentApproval, "PENDING");
    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET"]);
    assert.deepEqual(requests.map((request) => request.redirect), ["error", "error", "error"]);
    assert.deepEqual(
      requests.map((request) => request.url.pathname),
      [
        "/api/v2/projects/still-fog-96300663",
        "/api/v2/projects/still-fog-96300663/branches",
        "/api/v2/projects/still-fog-96300663/endpoints",
      ],
    );
    for (const request of requests) assert.equal(request.url.origin, "https://console.neon.tech");
    assert.equal(result.report.includes("offline-token"), false);
    assert.match(requests[1]!.url.search, /limit=100/);
    assert.match(requests[1]!.url.search, /sort_order=desc/);
  });

  it("rejects a missing credential before any request", async () => {
    let calls = 0;
    const fetchImpl: NeonApiFetch = async () => {
      calls += 1;
      throw new Error("network");
    };
    await assert.rejects(() => executeDiscovery(fetchImpl, "  "), /Neon API credential is required/);
    assert.equal(calls, 0);
  });

  it("does not import a database client or read application configuration", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(source, /dotenv|prisma|createPrismaSink|NEON_DB_URL|NEON_DIRECT_URL|process\.env\.MONGODB_URI/);
    assert.doesNotMatch(source, /approved:\s*\{[^}]*parentBranchId/s);
    assert.match(source, /STAGE17_NEON_API_TOKEN/);
    assert.match(source, /createNeonFetchAdapter/);
    assert.match(source, /createNeonReadTransport/);
    assert.match(source, /discoverNeonMetadata/);
    assert.doesNotMatch(source, /_migration/);
  });

  it("accepts a production root that omits parent_id", async () => {
    const fetchImpl: NeonApiFetch = async (request) => {
      if (request.url.pathname.endsWith("/branches")) {
        return page({
          branches: [
            { id: OPERATOR_OBSERVED.productionBranchId, name: "production" },
            { id: OPERATOR_OBSERVED.parentBranchId, name: OPERATOR_OBSERVED.parentName, parent_id: OPERATOR_OBSERVED.productionBranchId },
            { id: OPERATOR_OBSERVED.childBranchId, name: OPERATOR_OBSERVED.childName, parent_id: OPERATOR_OBSERVED.parentBranchId },
          ],
          pagination: { sort_order: "desc" },
        });
      }
      if (request.url.pathname.endsWith("/endpoints")) {
        return page({
          endpoints: [
            ...parentAndChild,
            { id: "ep-falling-brook-prod", branch_id: OPERATOR_OBSERVED.productionBranchId },
          ],
        });
      }
      return page({ project: { id: OPERATOR_OBSERVED.projectId } });
    };
    const result = await executeDiscovery(fetchImpl, "offline-token");
    assert.equal(result.mismatchCount, 0);
    assert.equal(result.parentApproval, "PENDING");
    assert.equal(result.writeAuthority, "none");
    assert.match(result.report, /parentMatch: yes/);
    assert.match(result.report, /childParentMatch: yes/);
  });

  it("accepts a production endpoint beside the parent and child endpoints", async () => {
    const { fetchImpl } = matchingFetch([
      ...parentAndChild,
      { id: "ep-falling-brook-prod", branch_id: OPERATOR_OBSERVED.productionBranchId },
    ]);
    const result = await executeDiscovery(fetchImpl, "offline-token");
    assert.equal(result.mismatchCount, 0);
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.parentApproval, "PENDING");
    assert.match(result.report, /observedEndpoints: other ep-falling-brook-prod branch br-old-bar-b4700916/);
    assert.match(result.report, /productionBranchInEndpointList: present/);
    assert.match(result.report, /parentEndpoint: parent ep-rapid-bread-b4gi8ftb branch br-super-haze-b4rhy28d/);
    assert.match(result.report, /childParentMatch: yes/);
    assert.match(result.report, /mismatches: none/);
    assert.equal(result.report.includes("offline-token"), false);
  });

  it("rejects a production endpoint owned by the rehearsal child", async () => {
    const { fetchImpl } = matchingFetch([
      { id: OPERATOR_OBSERVED.parentEndpointId, branch_id: OPERATOR_OBSERVED.parentBranchId },
      { id: "ep-falling-brook-prod", branch_id: OPERATOR_OBSERVED.childBranchId },
    ]);
    await assert.rejects(() => executeDiscovery(fetchImpl, "offline-token"), /production endpoint/);
  });

  it("records an endpoint on an unknown branch as a mismatch without approval", async () => {
    const fetchImpl: NeonApiFetch = async (request) => {
      if (request.url.pathname.endsWith("/branches")) {
        return page(projectBranches([{ id: "br-unknown", name: "other", parent_id: null }]));
      }
      if (request.url.pathname.endsWith("/endpoints")) {
        return page({
          endpoints: [
            ...parentAndChild,
            { id: "ep-other-1", branch_id: "br-unknown" },
          ],
        });
      }
      return page({ project: { id: OPERATOR_OBSERVED.projectId } });
    };
    const result = await executeDiscovery(fetchImpl, "offline-token");
    assert.match(result.report, /unknown endpoint owner/);
    assert.equal(result.writeAuthority, "none");
    assert.equal(result.parentApproval, "PENDING");
    assert.ok(result.mismatchCount > 0);
  });
});
