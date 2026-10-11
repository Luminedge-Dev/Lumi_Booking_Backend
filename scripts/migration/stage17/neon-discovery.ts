// Stage 17 F2 read-only Neon metadata discovery. Pure parser.
// A caller supplies an already retrieved response through NeonReadTransport.
// This module does not call the network, create a branch, or construct a client.
// Parsed metadata is evidence. writeAuthority stays none.

import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";
import { isLiveWriteCapability } from "./attestation";
import { PARENT_BRANCH_NAME, PRODUCTION_ENDPOINT_FRAGMENT, STAGE13_DEV_ENDPOINT_ID } from "./rehearsal-guard";

export const READ_ONLY_DISCOVERY_SEQUENCE = [
  "read the Neon project",
  "read branches and require exactly one stage13-dev parent",
  "record the parent branch id for operator approval when it is not already approved",
  "read endpoints and bind each endpoint id to its API branch_id",
  "when the rehearsal child name is absent, record the child as absent",
  "do not invent a child branch id or a child endpoint id",
  "do not require a child endpoint while the child is absent",
] as const;

/**
 * Official Neon API v2 contract, console.neon.tech, checked 2026-10-09.
 * A fixture that returns one page does not by itself prove a live collection is complete.
 */
export const LIVE_COLLECTION_COMPLETENESS = {
  status: "documented-contract",
  project: "GET /projects/{project_id} returns one project object and is not a paginated collection",
  branches: "GET /projects/{project_id}/branches accepts limit 1..10000 and cursor; pagination.next is absent on the last page",
  endpoints: "GET /projects/{project_id}/endpoints documents only project_id and an endpoints array, with no cursor or limit",
  branchPageLimit: 100,
  branchPageLimitMaximum: 10000,
  maxBranchPages: 20,
} as const;

export const OPERATOR_APPROVAL_FIELDS = [
  "Neon project id",
  "stage13-dev branch id",
  "rehearsal child branch name",
  "rehearsal child branch id",
  "rehearsal endpoint id",
  "API credential permitted to read branch metadata",
] as const;

export class DiscoveryStopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "DiscoveryStopError";
  }
}

/** Injected read boundary. No implementation in this slice performs I/O. */
export interface NeonReadTransport {
  readProject(): Promise<unknown> | unknown;
  readBranches(): Promise<unknown> | unknown;
  readEndpoints(): Promise<unknown> | unknown;
}

export interface ApprovedDiscoveryIdentity {
  readonly projectId?: string;
  readonly parentBranchId?: string;
  readonly childBranchName?: string;
}

export interface EndpointOwnership {
  readonly endpointId: string;
  readonly branchId: string;
  readonly role: "parent" | "child" | "other";
}

export type ChildObservation =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly id: string; readonly name: string; readonly parentId: string };

export interface NeonDiscoveryEvidence {
  readonly kind: "neon-read-evidence";
  readonly writeAuthority: "none";
  readonly observedProjectId: string;
  readonly projectStatus: "matches-approved" | "pending-operator-approval";
  readonly parent: { readonly id: string; readonly name: typeof PARENT_BRANCH_NAME; readonly parentId: string | null };
  readonly parentStatus: "matches-approved" | "pending-operator-approval";
  readonly child: ChildObservation;
  readonly endpoints: readonly EndpointOwnership[];
  readonly pendingApproval: readonly string[];
  readonly createsBranch: false;
}

export interface EndpointMappingRequest {
  readonly pooledUrl: string;
  readonly directUrl: string;
  readonly ownerBranchId: string;
}

interface ObservedBranch {
  id: string;
  name: string;
  parentId: string | null;
}

interface ObservedEndpoint {
  id: string;
  branchId: string;
}

export function planReadOnlyPreflight(childPresent: boolean): {
  readonly steps: readonly string[];
  readonly childEndpointRequired: false | true;
  readonly writeAuthority: "none";
  readonly createsBranch: false;
} {
  return {
    steps: READ_ONLY_DISCOVERY_SEQUENCE,
    childEndpointRequired: childPresent ? true : false,
    writeAuthority: "none",
    createsBranch: false,
  };
}

export async function discoverNeonMetadata(input: {
  transport: NeonReadTransport;
  approved?: ApprovedDiscoveryIdentity;
  endpointMapping?: EndpointMappingRequest;
  origin?: string;
}): Promise<NeonDiscoveryEvidence> {
  const approved = input.approved ?? {};
  const projectId = parseProjectId(await input.transport.readProject());
  const branches = parseBranches(await input.transport.readBranches(), approved.childBranchName);
  const endpoints = parseEndpoints(await input.transport.readEndpoints());
  const projectStatus = matchProject(projectId, approved.projectId);
  const parent = requireParent(branches, approved.parentBranchId);
  const child = observeChild(branches, parent.id, approved.childBranchName);
  const owned = ownEndpoints(endpoints, branches, parent.id, child);
  if (input.endpointMapping) bindEndpointMapping(input.endpointMapping, owned, child);
  const evidence: NeonDiscoveryEvidence = {
    kind: "neon-read-evidence",
    writeAuthority: "none",
    observedProjectId: projectId,
    projectStatus,
    parent,
    parentStatus: approved.parentBranchId === undefined ? "pending-operator-approval" : "matches-approved",
    child,
    endpoints: owned,
    pendingApproval: pendingFields(projectStatus, approved, child),
    createsBranch: false,
  };
  if (isLiveWriteCapability(evidence) || isLiveWriteCapability({ origin: input.origin })) {
    throw new DiscoveryStopError("parsed Neon metadata cannot mint write authority");
  }
  return evidence;
}

export function renderDiscoveryReport(evidence: NeonDiscoveryEvidence): string {
  const child = evidence.child.status === "absent" ? "absent" : `present parent=${evidence.child.parentId}`;
  const endpoints = evidence.endpoints.map((row) => `${row.role} ${row.endpointId} branch ${row.branchId}`).join(", ");
  const text = [
    `kind: ${evidence.kind}`,
    "writeAuthority: none",
    `projectStatus: ${evidence.projectStatus}`,
    `parent: ${evidence.parent.name}`,
    `child: ${child}`,
    `endpoints: ${endpoints || "none"}`,
    `pendingApproval: ${evidence.pendingApproval.join("; ")}`,
    "createsBranch: false",
  ].join("\n");
  if (/postgres(ql)?:\/\//i.test(text) || /:[^:@/\s]+@/.test(text)) throw new DiscoveryStopError("discovery report contains a credential");
  return `${text}\n`;
}

function matchProject(observed: string, approved: string | undefined): "matches-approved" | "pending-operator-approval" {
  if (approved === undefined) return "pending-operator-approval";
  if (approved.trim() === "") throw new DiscoveryStopError("approved project id is empty");
  if (observed !== approved) throw new DiscoveryStopError("observed project does not match the approved project");
  return "matches-approved";
}

function requireParent(branches: readonly ObservedBranch[], approvedId: string | undefined): NeonDiscoveryEvidence["parent"] {
  if (approvedId !== undefined && approvedId.trim() === "") throw new DiscoveryStopError("approved parent branch id is empty");
  const matches = branches.filter((branch) => branch.name === PARENT_BRANCH_NAME);
  if (matches.length === 0) throw new DiscoveryStopError("parent branch stage13-dev is missing");
  if (matches.length > 1) throw new DiscoveryStopError("parent branch stage13-dev is ambiguous");
  const parent = matches[0]!;
  if (approvedId !== undefined && parent.id !== approvedId) throw new DiscoveryStopError("observed parent branch does not match the approved parent");
  return { id: parent.id, name: PARENT_BRANCH_NAME, parentId: parent.parentId };
}

function observeChild(branches: readonly ObservedBranch[], parentId: string, childName: string | undefined): ChildObservation {
  if (childName === undefined) return { status: "absent" };
  if (childName.trim() === "" || childName === PARENT_BRANCH_NAME) throw new DiscoveryStopError("child branch name is stage13-dev");
  const matches = branches.filter((branch) => branch.name === childName);
  if (matches.length === 0) return { status: "absent" };
  if (matches.length > 1) throw new DiscoveryStopError("child branch name is ambiguous");
  const child = matches[0]!;
  if (child.id === parentId) throw new DiscoveryStopError("child branch id is the parent branch id");
  if (child.parentId !== parentId) throw new DiscoveryStopError("child branch parent does not match stage13-dev");
  return { status: "present", id: child.id, name: child.name, parentId };
}

function ownEndpoints(endpoints: readonly ObservedEndpoint[], branches: readonly ObservedBranch[], parentId: string, child: ChildObservation): EndpointOwnership[] {
  const branchIds = new Set(branches.map((branch) => branch.id));
  const seen = new Set<string>();
  const owned: EndpointOwnership[] = [];
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) throw new DiscoveryStopError("endpoint id is duplicated");
    seen.add(endpoint.id);
    if (!branchIds.has(endpoint.branchId)) throw new DiscoveryStopError("endpoint branch is not in the branch list");
    if (endpoint.id.includes(PRODUCTION_ENDPOINT_FRAGMENT)) assertProductionEndpointOwner(endpoint, branches, child);
    if (endpoint.id === STAGE13_DEV_ENDPOINT_ID && endpoint.branchId !== parentId) throw new DiscoveryStopError("parent endpoint is not owned by stage13-dev");
    const role = endpoint.branchId === parentId ? "parent" : child.status === "present" && endpoint.branchId === child.id ? "child" : "other";
    owned.push({ endpointId: endpoint.id, branchId: endpoint.branchId, role });
  }
  return owned;
}

function assertProductionEndpointOwner(endpoint: ObservedEndpoint, branches: readonly ObservedBranch[], child: ChildObservation): void {
  if (child.status === "present" && endpoint.branchId === child.id) {
    throw new DiscoveryStopError("a production endpoint was presented as a rehearsal endpoint");
  }
  const owner = branches.find((branch) => branch.id === endpoint.branchId);
  if (!owner || owner.name !== "production") throw new DiscoveryStopError("a production endpoint is not owned by the production branch");
}

function bindEndpointMapping(mapping: EndpointMappingRequest, owned: readonly EndpointOwnership[], child: ChildObservation): void {
  if (child.status === "absent") throw new DiscoveryStopError("child endpoint mapping requires an observed child branch");
  let pooled;
  let direct;
  try {
    pooled = classifyDatabaseUrl(mapping.pooledUrl);
    direct = classifyDatabaseUrl(mapping.directUrl);
  } catch {
    throw new DiscoveryStopError("a Neon URL is malformed");
  }
  if (pooled.provider !== "neon" || direct.provider !== "neon") throw new DiscoveryStopError("targets must be Neon PostgreSQL endpoints");
  if (!pooled.pooled || direct.pooled) throw new DiscoveryStopError("the pooled URL and the direct URL do not form a pooled/direct pair");
  if (pooled.database !== direct.database) {
    if (pooled.database !== "neondb") throw new DiscoveryStopError("pooled URL database is not neondb");
    throw new DiscoveryStopError("direct URL database is not neondb");
  }
  if (pooled.database !== "neondb") throw new DiscoveryStopError("database name is not neondb");
  const pooledId = normalizedEndpointId(mapping.pooledUrl);
  const directId = normalizedEndpointId(mapping.directUrl);
  if (pooledId !== directId) throw new DiscoveryStopError("pooled and direct endpoints differ");
  if (pooledId === STAGE13_DEV_ENDPOINT_ID) throw new DiscoveryStopError("parent endpoint was presented as a child endpoint");
  if (pooledId.includes(PRODUCTION_ENDPOINT_FRAGMENT)) throw new DiscoveryStopError("a production endpoint was presented as a rehearsal endpoint");
  const rows = owned.filter((row) => row.endpointId === pooledId);
  if (rows.length !== 1) throw new DiscoveryStopError("endpoint mapping is ambiguous");
  const row = rows[0]!;
  if (row.branchId !== mapping.ownerBranchId || row.branchId !== child.id) throw new DiscoveryStopError("endpoint ownership does not match the child branch");
}

function pendingFields(projectStatus: NeonDiscoveryEvidence["projectStatus"], approved: ApprovedDiscoveryIdentity, child: ChildObservation): string[] {
  const pending: string[] = [];
  if (projectStatus === "pending-operator-approval") pending.push("Neon project id");
  if (approved.parentBranchId === undefined) pending.push("stage13-dev branch id");
  if (approved.childBranchName === undefined) pending.push("rehearsal child branch name");
  if (child.status === "absent") {
    pending.push("rehearsal child branch id");
    pending.push("rehearsal endpoint id");
  }
  pending.push("API credential permitted to read branch metadata");
  return pending;
}

function parseProjectId(value: unknown): string {
  const body = record(value, "project response");
  const project = record(body.project, "project response");
  if (typeof project.id !== "string" || project.id.trim() === "") throw new DiscoveryStopError("project response is incomplete");
  return project.id;
}

function parseBranches(value: unknown, childName: string | undefined): ObservedBranch[] {
  const body = record(value, "branch response");
  if (!Array.isArray(body.branches)) throw new DiscoveryStopError("branch response is incomplete");
  const seen = new Set<string>();
  const parsed = body.branches.map((item) => {
    const branch = record(item, "branch response");
    if (typeof branch.id !== "string" || branch.id.trim() === "") throw new DiscoveryStopError("branch id is missing");
    if (seen.has(branch.id)) throw new DiscoveryStopError("branch id is duplicated");
    seen.add(branch.id);
    if (typeof branch.name !== "string" || branch.name.trim() === "") throw new DiscoveryStopError("branch name is missing");
    return { id: branch.id, name: branch.name, parentId: readParentId(branch) };
  });
  return acceptOmittedRoot(parsed, childName);
}

function readParentId(branch: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(branch, "parent_id")) return undefined;
  if (branch.parent_id === null) return null;
  if (typeof branch.parent_id !== "string" || branch.parent_id.trim() === "") throw new DiscoveryStopError("branch parent_id is malformed");
  return branch.parent_id;
}

/** Neon list-branches omits parent_id on the single root. Child branches must include it. */
function acceptOmittedRoot(
  branches: readonly { id: string; name: string; parentId: string | null | undefined }[],
  childName: string | undefined,
): ObservedBranch[] {
  const omitted = branches.filter((branch) => branch.parentId === undefined);
  for (const branch of omitted) {
    if (branch.name === PARENT_BRANCH_NAME) throw new DiscoveryStopError("stage13-dev parent_id is missing");
    if (childName !== undefined && branch.name === childName) throw new DiscoveryStopError("rehearsal child parent_id is missing");
  }
  if (omitted.length > 1) throw new DiscoveryStopError("branch parent_id is missing on more than one branch");
  return branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    parentId: branch.parentId === undefined ? null : branch.parentId,
  }));
}

function parseEndpoints(value: unknown): ObservedEndpoint[] {
  const body = record(value, "endpoint response");
  if (!Array.isArray(body.endpoints)) throw new DiscoveryStopError("endpoint response is incomplete");
  return body.endpoints.map((item) => {
    const endpoint = record(item, "endpoint response");
    if (typeof endpoint.id !== "string" || endpoint.id.trim() === "") throw new DiscoveryStopError("endpoint response is incomplete");
    if (typeof endpoint.branch_id !== "string" || endpoint.branch_id.trim() === "") throw new DiscoveryStopError("endpoint response is incomplete");
    return { id: endpoint.id, branchId: endpoint.branch_id };
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DiscoveryStopError(`${label} is incomplete`);
  return value as Record<string, unknown>;
}
