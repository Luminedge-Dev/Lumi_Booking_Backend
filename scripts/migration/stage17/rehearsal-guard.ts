// Stage 17 rehearsal fact check. Pure. No Neon API and no database connection.
//
// verifyRehearsalTarget validates caller-supplied URL and branch facts and
// brands them as facts only. The brand is not a write capability. A caller
// cannot turn facts into cleanup authority by setting an origin string.
//
// A later live attestor must obtain Neon metadata from an authorized API
// response and compare it with a client that attestor constructed. This
// module exports no factory for that capability.

import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";

export const REHEARSAL_ACK = "stage17-rehearsal";
export const PARENT_BRANCH_NAME = "stage13-dev";
export const STAGE13_DEV_ENDPOINT_ID = "ep-rapid-bread-b4gi8ftb";
export const PRODUCTION_ENDPOINT_FRAGMENT = "falling-brook";

const factBrands = new WeakSet<object>();

export interface ApprovedRehearsalIdentity {
  projectId: string;
  parentBranchId: string;
  parentBranchName: typeof PARENT_BRANCH_NAME;
  childBranchName: string;
  endpointId: string;
}

/** Caller-supplied branch facts. An origin label is not part of this contract. */
export interface RehearsalBranchMetadata {
  projectId: string;
  parentBranchId: string;
  parentBranchName: string;
  childBranchId: string;
  childBranchName: string;
  endpointIds: readonly string[];
}

export interface ValidatedRehearsalFacts {
  readonly kind: "rehearsal-facts";
  readonly endpointId: string;
  readonly authority: "none";
}

export class RehearsalStopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "RehearsalStopError";
  }
}

export function isValidatedRehearsalFacts(value: unknown): value is ValidatedRehearsalFacts {
  return typeof value === "object" && value !== null && factBrands.has(value);
}

/** Always false. Live write authority is not constructable from this module. */
export function allowsDestructiveRehearsal(): false {
  return false;
}

export interface RehearsalGuardInput {
  acknowledgement: string;
  pooledUrl: string;
  directUrl: string;
  approved: ApprovedRehearsalIdentity;
  metadata: RehearsalBranchMetadata;
}

function refuseParentOrProduction(endpointId: string): void {
  if (endpointId.length === 0) throw new RehearsalStopError("rehearsal endpoint id is empty");
  if (endpointId === STAGE13_DEV_ENDPOINT_ID) throw new RehearsalStopError("stage13-dev is not a rehearsal target");
  if (endpointId.includes(PRODUCTION_ENDPOINT_FRAGMENT)) throw new RehearsalStopError("a production endpoint was detected");
}

export function verifyRehearsalTarget(input: RehearsalGuardInput): ValidatedRehearsalFacts {
  if (input.acknowledgement !== REHEARSAL_ACK) throw new RehearsalStopError("rehearsal acknowledgement is not stage17-rehearsal");
  refuseParentOrProduction(input.approved.endpointId);

  let pooled;
  let direct;
  try {
    pooled = classifyDatabaseUrl(input.pooledUrl);
    direct = classifyDatabaseUrl(input.directUrl);
  } catch {
    throw new RehearsalStopError("a Neon URL is malformed");
  }
  if (pooled.provider !== "neon" || direct.provider !== "neon") throw new RehearsalStopError("targets must be Neon PostgreSQL endpoints");
  if (!pooled.pooled || direct.pooled) throw new RehearsalStopError("the pooled URL and the direct URL do not form a pooled/direct pair");
  if (pooled.database !== "neondb" || direct.database !== "neondb") throw new RehearsalStopError("database name is not neondb");

  const pooledId = normalizedEndpointId(input.pooledUrl);
  const directId = normalizedEndpointId(input.directUrl);
  if (pooledId !== directId) throw new RehearsalStopError("pooled and direct endpoints differ");
  refuseParentOrProduction(pooledId);
  if (pooledId !== input.approved.endpointId) throw new RehearsalStopError("endpoint id does not match the approved rehearsal endpoint");

  const approved = input.approved;
  const metadata = input.metadata;
  if (approved.parentBranchName !== PARENT_BRANCH_NAME) throw new RehearsalStopError("approved parent branch is not stage13-dev");
  if (metadata.parentBranchName !== approved.parentBranchName) throw new RehearsalStopError("metadata parent branch does not match the approved parent");
  if (metadata.parentBranchId !== approved.parentBranchId) throw new RehearsalStopError("metadata parent branch id does not match the approved parent");
  if (metadata.projectId !== approved.projectId) throw new RehearsalStopError("metadata project id does not match the approved project");
  if (metadata.childBranchId === metadata.parentBranchId) throw new RehearsalStopError("parent and child branch ids are the same");
  if (metadata.childBranchName === PARENT_BRANCH_NAME) throw new RehearsalStopError("child branch name is stage13-dev");
  if (metadata.childBranchName !== approved.childBranchName) throw new RehearsalStopError("metadata child branch name does not match the approved rehearsal name");
  if (!metadata.endpointIds.includes(pooledId)) throw new RehearsalStopError("branch metadata does not list the connected endpoint");

  const facts: ValidatedRehearsalFacts = { kind: "rehearsal-facts", endpointId: pooledId, authority: "none" };
  factBrands.add(facts);
  return facts;
}
