// Stage 17 F2 offline attestation contracts. Pure. No Neon API, no Prisma
// client, and no database connection.
//
// Caller-supplied JSON, URLs, branch names, and origin labels can be checked
// for shape. They cannot become a write capability. This module has no
// function that brands a live API response or a live client.

import { assessCleanup, type ForeignKeyReferencer, type IdentityCensus } from "./allowlist";
import {
  PRODUCTION_ENDPOINT_FRAGMENT,
  STAGE13_DEV_ENDPOINT_ID,
  verifyRehearsalTarget,
  type RehearsalGuardInput,
  type ValidatedRehearsalFacts,
} from "./rehearsal-guard";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";

export const ATTESTATION_MAX_AGE_MS = 5 * 60 * 1000;

export const LIVE_ATTESTATION_REQUIREMENTS = [
  "Neon API response for the approved project, read by the attestor",
  "parent branch id and name stage13-dev from that API response",
  "child branch id and name distinct from the parent",
  "API endpoint list for the child branch",
  "Prisma client constructed by the attestor from the mapped pooled URL",
  "direct URL checked against that same endpoint before construction",
  "current_database() read through that same client equals neondb",
  "pg_constraint referencers read through that same client",
  "sessions, accounts, and verifications counts read through that same client",
  "both observation timestamps inside the revalidation window",
] as const;

export class AttestationStopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "AttestationStopError";
  }
}

export interface StructuralIdentity {
  readonly kind: "structural-rehearsal-identity";
  readonly structurallyValid: true;
  readonly writeAuthority: "none";
  readonly projectId: string;
  readonly parentBranchId: string;
  readonly parentBranchName: "stage13-dev";
  readonly childBranchId: string;
  readonly childBranchName: string;
  readonly endpointId: string;
  readonly databaseName: "neondb";
  readonly facts: ValidatedRehearsalFacts;
}

export interface ConstructedDatasource {
  readonly pooledUrl: string;
  readonly directUrl: string;
}

export interface ClientIdentity {
  readonly token: object;
}

export interface ApiEndpointMapping {
  projectId: string;
  parentBranchId: string;
  parentBranchName: string;
  childBranchId: string;
  childBranchName: string;
  endpointIds: readonly string[];
  observedAt: string;
}

export interface ConnectionProbe {
  readonly through: object;
  readonly endpointId: string;
  readonly currentDatabase: string;
  readonly observedAt: string;
}

export interface OfflineAttestationReview {
  readonly kind: "offline-attestation-review";
  readonly writeAuthority: "none";
  readonly cleanupAuthority: "none";
  readonly loadAuthority: "none";
  readonly productionWriteAuthority: "none";
  readonly liveEvidence: "not-attested";
}

export interface OfflineSimulation {
  readonly kind: "offline-simulation";
  readonly productionWriteAuthority: "none";
  readonly cleanupAuthority: "none";
  readonly loadAuthority: "none";
}

export interface CleanupScopeReview {
  readonly scope: "cleanup";
  readonly authority: "none";
}

export interface LoadScopeReview {
  readonly scope: "load";
  readonly authority: "none";
}

export interface InjectedProbeInput {
  structural: StructuralIdentity;
  mapping: ApiEndpointMapping | null;
  datasource: ConstructedDatasource;
  client: ClientIdentity;
  probe: ConnectionProbe | null;
  referencers: readonly ForeignKeyReferencer[] | null;
  identity: IdentityCensus | null;
  now: string;
  maxAgeMs?: number;
}

/** A caller object is never a live Neon API response in this slice. */
export function isLiveNeonApiResponse(_value: unknown): false {
  return false;
}

/** A caller object is never a live write capability in this slice. */
export function isLiveWriteCapability(_value: unknown): false {
  return false;
}

export function mintLiveCapability(): never {
  throw new AttestationStopError("live Neon attestation is not available");
}

export function authorizeLoadExecution(): never {
  throw new AttestationStopError("load execution requires a live Neon attestation, which is not available");
}

export function authorizeBranchCreate(): never {
  throw new AttestationStopError("branch creation is not available");
}

export function authorizeReconcileWrite(): never {
  throw new AttestationStopError("reconcile writes are not available");
}

export function claimLivePreflight(_claim: { origin?: string }): never {
  throw new AttestationStopError("a caller-provided origin does not attest a live Neon target");
}

export function rejectUrlOnlyBranchProof(_proof: { url?: string; currentDatabase?: string }): never {
  throw new AttestationStopError("a URL and current_database() do not prove branch identity");
}

export function simulateOfflineAuthorization(): OfflineSimulation {
  return { kind: "offline-simulation", productionWriteAuthority: "none", cleanupAuthority: "none", loadAuthority: "none" };
}

export function validateStructuralIdentity(input: RehearsalGuardInput): StructuralIdentity {
  if (input.metadata.childBranchId.trim() === "") throw new AttestationStopError("child branch id is missing");
  const facts = verifyRehearsalTarget(input);
  if (facts.authority !== "none") throw new AttestationStopError("rehearsal facts cannot carry write authority");
  return {
    kind: "structural-rehearsal-identity",
    structurallyValid: true,
    writeAuthority: "none",
    projectId: input.approved.projectId,
    parentBranchId: input.approved.parentBranchId,
    parentBranchName: "stage13-dev",
    childBranchId: input.metadata.childBranchId,
    childBranchName: input.approved.childBranchName,
    endpointId: facts.endpointId,
    databaseName: "neondb",
    facts,
  };
}

export function describeConstructedConnection(client: ClientIdentity, datasource: ConstructedDatasource): {
  readonly kind: "untrusted-client-binding";
  readonly authority: "none";
  readonly endpointId: string;
  readonly client: object;
} {
  const pair = assertPooledDirectPair(datasource);
  return { kind: "untrusted-client-binding", authority: "none", endpointId: pair.endpointId, client: client.token };
}

export function evaluateInjectedProbe(input: InjectedProbeInput): OfflineAttestationReview {
  if (input.mapping === null || input.probe === null) throw new AttestationStopError("attestation evidence is missing");
  const maxAgeMs = input.maxAgeMs ?? ATTESTATION_MAX_AGE_MS;
  requireFresh(input.mapping.observedAt, input.now, maxAgeMs);
  requireFresh(input.probe.observedAt, input.now, maxAgeMs);
  const pair = assertPooledDirectPair(input.datasource);
  if (pair.endpointId !== input.structural.endpointId) throw new AttestationStopError("constructed datasource does not match the structural endpoint");
  if (!input.mapping.endpointIds.includes(pair.endpointId)) throw new AttestationStopError("API endpoint mapping does not contain the constructed datasource");
  if (input.mapping.projectId !== input.structural.projectId) throw new AttestationStopError("API project id does not match the approved project");
  if (input.mapping.parentBranchId !== input.structural.parentBranchId || input.mapping.parentBranchName !== input.structural.parentBranchName) {
    throw new AttestationStopError("API parent branch does not match the approved parent");
  }
  if (input.mapping.childBranchId !== input.structural.childBranchId || input.mapping.childBranchName !== input.structural.childBranchName) {
    throw new AttestationStopError("API child branch does not match the approved child");
  }
  if (input.mapping.childBranchId === input.mapping.parentBranchId) throw new AttestationStopError("parent and child branch ids are the same");
  if (input.probe.endpointId !== pair.endpointId) throw new AttestationStopError("connection probe endpoint does not match the constructed datasource");
  if (input.probe.currentDatabase !== "neondb") throw new AttestationStopError("database name is not neondb");
  if (input.probe.through !== input.client.token) throw new AttestationStopError("database evidence was not read through the constructed client");
  if (input.referencers === null) throw new AttestationStopError("foreign-key metadata is missing");
  if (input.identity === null) throw new AttestationStopError("identity census is missing");
  const cleanup = assessCleanup({ facts: input.structural.facts, referencers: input.referencers, identity: input.identity });
  if (cleanup.executionAuthority !== "none" || cleanup.liveEvidence !== "not-attested") {
    throw new AttestationStopError("cleanup review cannot grant execution");
  }
  if (isLiveNeonApiResponse(input.mapping) || isLiveWriteCapability(input.client)) {
    throw new AttestationStopError("offline evidence cannot become a live capability");
  }
  return {
    kind: "offline-attestation-review",
    writeAuthority: "none",
    cleanupAuthority: "none",
    loadAuthority: "none",
    productionWriteAuthority: "none",
    liveEvidence: "not-attested",
  };
}

export function revalidateAttestation(input: {
  previous: { observedAt: string; endpointId: string; client: object };
  next: { observedAt: string; endpointId: string; client: object };
  now: string;
  maxAgeMs?: number;
}): { readonly fresh: true; readonly authority: "none" } {
  const maxAgeMs = input.maxAgeMs ?? ATTESTATION_MAX_AGE_MS;
  requireFresh(input.previous.observedAt, input.now, maxAgeMs);
  requireFresh(input.next.observedAt, input.now, maxAgeMs);
  if (input.previous.client !== input.next.client) throw new AttestationStopError("revalidation client does not match the attested connection");
  if (input.previous.endpointId !== input.next.endpointId) throw new AttestationStopError("revalidation endpoint does not match the attested connection");
  return { fresh: true, authority: "none" };
}

export function reviewCleanupScope(review: OfflineAttestationReview): CleanupScopeReview {
  assertOfflineReview(review);
  return { scope: "cleanup", authority: "none" };
}

export function reviewLoadScope(review: OfflineAttestationReview): LoadScopeReview {
  assertOfflineReview(review);
  return { scope: "load", authority: "none" };
}

export function requireLoadScope(value: { readonly scope: string }): void {
  if (value.scope !== "load") throw new AttestationStopError("load scope is independent of cleanup scope");
}

export function requireCleanupScope(value: { readonly scope: string }): void {
  if (value.scope !== "cleanup") throw new AttestationStopError("cleanup scope is independent of load scope");
}

function assertOfflineReview(review: OfflineAttestationReview): void {
  if (review.kind !== "offline-attestation-review" || review.writeAuthority !== "none" || review.liveEvidence !== "not-attested") {
    throw new AttestationStopError("attestation review is not an offline refusal");
  }
}

function assertPooledDirectPair(datasource: ConstructedDatasource): { endpointId: string; databaseName: "neondb" } {
  let pooled;
  let direct;
  try {
    pooled = classifyDatabaseUrl(datasource.pooledUrl);
    direct = classifyDatabaseUrl(datasource.directUrl);
  } catch {
    throw new AttestationStopError("a Neon URL is malformed");
  }
  if (pooled.provider !== "neon" || direct.provider !== "neon") throw new AttestationStopError("targets must be Neon PostgreSQL endpoints");
  if (!pooled.pooled || direct.pooled) throw new AttestationStopError("the pooled URL and the direct URL do not form a pooled/direct pair");
  if (pooled.database !== "neondb" || direct.database !== "neondb") throw new AttestationStopError("database name is not neondb");
  const pooledId = normalizedEndpointId(datasource.pooledUrl);
  const directId = normalizedEndpointId(datasource.directUrl);
  if (pooledId !== directId) throw new AttestationStopError("pooled and direct endpoints differ");
  if (pooledId.length === 0) throw new AttestationStopError("rehearsal endpoint id is empty");
  if (pooledId === STAGE13_DEV_ENDPOINT_ID) throw new AttestationStopError("stage13-dev is not a rehearsal target");
  if (pooledId.includes(PRODUCTION_ENDPOINT_FRAGMENT)) throw new AttestationStopError("a production endpoint was detected");
  return { endpointId: pooledId, databaseName: "neondb" };
}

function requireFresh(observedAt: string, now: string, maxAgeMs: number): void {
  const observed = Date.parse(observedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) throw new AttestationStopError("attestation evidence is missing");
  const age = current - observed;
  if (age < 0 || age > maxAgeMs) throw new AttestationStopError("attestation evidence is stale");
}
