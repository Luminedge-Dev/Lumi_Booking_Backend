// GET-only Neon discovery comparison. Importing this file does not call the network.
// The one-shot process reads STAGE17_NEON_API_TOKEN only when main() runs.
// The token is never printed or stored. Production endpoints stay observations.

import { createNeonFetchAdapter, createNeonReadTransport, type NeonApiFetch } from "./neon-api-transport";
import { discoverNeonMetadata, DiscoveryStopError, type EndpointOwnership, type NeonDiscoveryEvidence } from "./neon-discovery";
import { PRODUCTION_ENDPOINT_FRAGMENT } from "./rehearsal-guard";

export const OPERATOR_OBSERVED = {
  projectId: "still-fog-96300663",
  parentName: "stage13-dev",
  parentBranchId: "br-super-haze-b4rhy28d",
  parentEndpointId: "ep-rapid-bread-b4gi8ftb",
  childName: "stage17-rehearsal",
  childBranchId: "br-shy-rain-b4f301ml",
  childEndpointId: "ep-dark-brook-b4atip73",
  productionBranchId: "br-old-bar-b4700916",
} as const;

export interface DiscoveryComparison {
  readonly report: string;
  readonly mismatchCount: number;
  readonly writeAuthority: "none";
  readonly createsBranch: false;
  readonly parentApproval: "PENDING";
}

export async function executeDiscovery(fetchImpl: NeonApiFetch, token = process.env.STAGE17_NEON_API_TOKEN ?? ""): Promise<DiscoveryComparison> {
  const transport = createNeonReadTransport({
    projectId: OPERATOR_OBSERVED.projectId,
    token,
    fetchImpl,
  });
  const evidence = await discoverNeonMetadata({
    transport,
    approved: {
      projectId: OPERATOR_OBSERVED.projectId,
      childBranchName: OPERATOR_OBSERVED.childName,
    },
  });
  return compareObservedIdentities(evidence);
}

export function compareObservedIdentities(evidence: NeonDiscoveryEvidence): DiscoveryComparison {
  const mismatches: string[] = [];
  if (evidence.writeAuthority !== "none") mismatches.push("write authority is not none");
  if (evidence.createsBranch !== false) mismatches.push("createsBranch is not false");
  if (evidence.parentStatus !== "pending-operator-approval") mismatches.push("parent branch was approved inside discovery");
  if (evidence.observedProjectId !== OPERATOR_OBSERVED.projectId) mismatches.push("project id mismatch");
  if (evidence.parent.name !== OPERATOR_OBSERVED.parentName || evidence.parent.id !== OPERATOR_OBSERVED.parentBranchId) {
    mismatches.push("parent branch mismatch");
  }
  if (evidence.parent.parentId !== OPERATOR_OBSERVED.productionBranchId) mismatches.push("stage13-dev parent mismatch");

  const child = evidence.child;
  const childPresent = child.status === "present";
  if (!childPresent) mismatches.push("child branch is absent");
  if (childPresent && child.id !== OPERATOR_OBSERVED.childBranchId) mismatches.push("child branch id mismatch");
  if (childPresent && (child.parentId !== evidence.parent.id || child.parentId !== OPERATOR_OBSERVED.parentBranchId)) {
    mismatches.push("child parent mismatch");
  }

  const parentEndpoint = evidence.endpoints.find((row) => row.endpointId === OPERATOR_OBSERVED.parentEndpointId);
  const childEndpoint = evidence.endpoints.find((row) => row.endpointId === OPERATOR_OBSERVED.childEndpointId);
  if (!parentEndpoint || parentEndpoint.role !== "parent" || parentEndpoint.branchId !== OPERATOR_OBSERVED.parentBranchId) {
    mismatches.push("parent endpoint ownership mismatch");
  }
  if (!childPresent || !childEndpoint || childEndpoint.role !== "child" || childEndpoint.branchId !== OPERATOR_OBSERVED.childBranchId) {
    mismatches.push("child endpoint ownership mismatch");
  }
  const knownOwners = new Set<string>([
    OPERATOR_OBSERVED.productionBranchId,
    OPERATOR_OBSERVED.parentBranchId,
    OPERATOR_OBSERVED.childBranchId,
  ]);
  const extras = evidence.endpoints.filter(
    (row) => row.endpointId !== OPERATOR_OBSERVED.parentEndpointId && row.endpointId !== OPERATOR_OBSERVED.childEndpointId,
  );
  const unknownOwners = extras.filter((row) => !knownOwners.has(row.branchId));
  const observed = extras.filter((row) => knownOwners.has(row.branchId));
  if (unknownOwners.length > 0) mismatches.push("unknown endpoint owner");
  if (evidence.endpoints.some((row) => row.endpointId.includes(PRODUCTION_ENDPOINT_FRAGMENT) && row.branchId === OPERATOR_OBSERVED.childBranchId)) {
    mismatches.push("production endpoint accepted as rehearsal child");
  }
  const seen = new Set<string>();
  for (const row of evidence.endpoints) {
    if (seen.has(row.endpointId)) mismatches.push("endpoint id is duplicated");
    seen.add(row.endpointId);
  }

  const productionOwned = evidence.endpoints.some((row) => row.branchId === OPERATOR_OBSERVED.productionBranchId);
  const report = [
    "kind: neon-read-evidence",
    "writeAuthority: none",
    "createsBranch: false",
    "parentApproval: PENDING",
    "apiAttestation: not-approved",
    "paginationCompleteness: complete",
    `projectId: ${evidence.observedProjectId}`,
    `projectMatch: ${evidence.observedProjectId === OPERATOR_OBSERVED.projectId ? "yes" : "no"}`,
    `parentBranchId: ${evidence.parent.id}`,
    `parentMatch: ${evidence.parent.id === OPERATOR_OBSERVED.parentBranchId ? "yes" : "no"}`,
    `parentEndpoint: ${endpointLine(parentEndpoint)}`,
    `child: ${childPresent ? "present" : "absent"}`,
    `childBranchId: ${childPresent ? child.id : "absent"}`,
    `childMatch: ${childPresent && child.id === OPERATOR_OBSERVED.childBranchId ? "yes" : "no"}`,
    `childParentMatch: ${childPresent && child.parentId === OPERATOR_OBSERVED.parentBranchId ? "yes" : "no"}`,
    `childEndpoint: ${endpointLine(childEndpoint)}`,
    `observedEndpoints: ${observed.length === 0 ? "none" : observed.map((row) => endpointLine(row)).join(", ")}`,
    `productionBranchInEndpointList: ${productionOwned ? "present" : "absent"}`,
    `mismatches: ${mismatches.length === 0 ? "none" : mismatches.join("; ")}`,
  ].join("\n");
  if (/postgres(ql)?:\/\//i.test(report) || /:[^:@/\s]+@/.test(report) || report.includes("Bearer ")) {
    throw new DiscoveryStopError("discovery report contains a credential");
  }
  return {
    report: `${report}\n`,
    mismatchCount: mismatches.length,
    writeAuthority: "none",
    createsBranch: false,
    parentApproval: "PENDING",
  };
}

function endpointLine(row: EndpointOwnership | undefined): string {
  if (!row) return "absent";
  return `${row.role} ${row.endpointId} branch ${row.branchId}`;
}

export async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) throw new DiscoveryStopError("unexpected argument");
  const comparison = await executeDiscovery(createNeonFetchAdapter((url, init) => fetch(url, init)));
  process.stdout.write(comparison.report);
  if (comparison.mismatchCount > 0) process.exitCode = 2;
}
