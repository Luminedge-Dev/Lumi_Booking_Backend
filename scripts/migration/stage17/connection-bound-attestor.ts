// Stage 17 connection-bound attestor.
// Importing this file does not call Neon, open Prisma, or read application environment.
// The WebSocket Neon adapter starts a transaction with BEGIN. This module then
// issues SET TRANSACTION READ ONLY on that same transaction and requires
// current_setting('transaction_read_only') to be on before any catalog read.
// A passing review does not grant cleanup, load, or write authority.
// Injected clients are not live evidence.

import { PrismaNeon } from "@prisma/adapter-neon";
import { Client } from "pg";
import { PrismaClient } from "../../../src/generated/prisma/client.js";
import { AttestationStopError, ATTESTATION_MAX_AGE_MS } from "./attestation";
import { createNeonFetchAdapter, createNeonReadTransport, type NeonApiFetch } from "./neon-api-transport";
import { discoverNeonMetadata, DiscoveryStopError } from "./neon-discovery";
import { compareObservedIdentities, OPERATOR_OBSERVED } from "./neon-discover-once";
import {
  mapCatalog,
  PREFLIGHT_CONNECTION_TIMEOUT_MS,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
  PreflightTimeoutError,
  type PreflightQueryResult,
} from "./readonly-preflight-adapter";
import { assertReadOnlyChildUrls, PREFLIGHT_STATEMENTS, PreflightStopError, reviewReadOnlyPreflight } from "./readonly-preflight";
import {
  READ_ONLY_PROOF_SQL,
  READ_ONLY_ROLLBACK_SQL,
  readOnlyStatementTimeoutSql,
} from "./readonly-session-contract";

export const ATTESTOR_ROLE = "stage17_preflight_reader";
export const SET_TRANSACTION_READ_ONLY_SQL = "SET TRANSACTION READ ONLY";

export const ATTESTOR_FAILURE_PHASES = [
  "API_METADATA",
  "PRISMA_CLIENT_CONSTRUCTION",
  "DATABASE_TRANSACTION_START",
  "READ_ONLY_TRANSACTION_SETUP",
  "DATABASE_ROLE_PROOF",
  "CATALOG_QUERY",
  "TRANSACTION_CLEANUP",
  "CLIENT_DISCONNECT",
] as const;

export type AttestorFailurePhase = (typeof ATTESTOR_FAILURE_PHASES)[number];

const SAFE_DRIVER_CODES = new Set([
  "P1001",
  "P1002",
  "P1017",
  "P2010",
  "P2024",
  "P2028",
  "28P01",
  "28000",
  "42501",
  "25001",
  "57014",
  "08001",
  "08003",
  "08006",
  "53300",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
]);

const constructedClients = new WeakSet<object>();

export interface AttestorTx {
  readonly token: object;
  execute(sql: string): Promise<void>;
  query(sql: string): Promise<PreflightQueryResult>;
}

/** One Prisma transaction. Every catalog read must use this callback's tx. */
export interface AttestorPrismaClient {
  readonly token: object;
  runReadOnly(work: (tx: AttestorTx) => Promise<void>): Promise<void>;
  disconnect(): Promise<void>;
}

export interface OpenAttestorPrisma {
  (input: { readonly pooledUrl: string }): Promise<AttestorPrismaClient>;
}

export interface ConnectionBoundAttestation {
  readonly kind: "stage17-connection-bound-attestation";
  readonly connectionBoundChecks: "passed";
  readonly neonApiEndpointOwnership: "verified";
  readonly databaseSessionIdentity: "verified";
  readonly operatorApprovalForLaterOperations: "required";
  readonly evidenceClass: "injected-fixture" | "attestor-constructed";
  readonly liveEvidence: "not-attested" | "connection-bound-observed";
  readonly apiAttestation: "not-approved";
  readonly writeAuthority: "none";
  readonly cleanupAuthorized: false;
  readonly loadAuthorized: false;
  readonly productionWriteAuthority: "none";
  readonly report: string;
}

export function classifyLiveEvidence(input: {
  clientConstructed: boolean;
  transportApproved: boolean;
  clockInjected: boolean;
}): ConnectionBoundAttestation["liveEvidence"] {
  if (input.clientConstructed && input.transportApproved && !input.clockInjected) return "connection-bound-observed";
  return "not-attested";
}

export async function executeConnectionBoundAttestation(input: {
  pooledUrl: string;
  directUrl: string;
  token: string;
  fetchImpl?: NeonApiFetch;
  clock?: () => string;
  openPrisma?: OpenAttestorPrisma;
}): Promise<ConnectionBoundAttestation> {
  assertAttestorUrls(input.pooledUrl, input.directUrl);
  const clockInjected = input.clock !== undefined;
  const transportApproved = input.fetchImpl === undefined;
  const clock = input.clock ?? (() => new Date().toISOString());
  const fetchImpl = input.fetchImpl ?? createNeonFetchAdapter((url, init) => fetch(url, init));
  let client: AttestorPrismaClient | undefined;
  let failure: unknown;
  try {
    await readApprovedApi(input.token, fetchImpl);
    const apiObservedAt = clock();
    try {
      client = await (input.openPrisma ?? openAttestorPrismaClient)({ pooledUrl: input.pooledUrl });
    } catch (error) {
      throw preserveOrClassify(error, "PRISMA_CLIENT_CONSTRUCTION");
    }
    const opened = client;
    let catalogResults: PreflightQueryResult[] | undefined;
    await opened.runReadOnly(async (tx) => {
      if (tx.token !== opened.token) throw new AttestationStopError("database evidence was not read through the constructed client");
      let workError: unknown;
      try {
        await phaseStep("READ_ONLY_TRANSACTION_SETUP", () => tx.execute(SET_TRANSACTION_READ_ONLY_SQL));
        const proof = await phaseStep("DATABASE_ROLE_PROOF", () => tx.query(READ_ONLY_PROOF_SQL));
        assertServerProof(proof);
        await phaseStep("READ_ONLY_TRANSACTION_SETUP", () => tx.execute(readOnlyStatementTimeoutSql(PREFLIGHT_STATEMENT_TIMEOUT_MS)));
        const results: PreflightQueryResult[] = [];
        for (const statement of PREFLIGHT_STATEMENTS) {
          results.push(await phaseStep("CATALOG_QUERY", () => tx.query(statement)));
        }
        catalogResults = results;
      } catch (error) {
        workError = error;
      } finally {
        try {
          await tx.execute(READ_ONLY_ROLLBACK_SQL);
        } catch (rollbackError) {
          if (workError === undefined) workError = preserveOrClassify(rollbackError, "TRANSACTION_CLEANUP");
        }
      }
      if (workError) throw workError;
    });
    const dbObservedAt = clock();
    const evaluatedAt = clock();
    assertBoundTimestamps(apiObservedAt, dbObservedAt, evaluatedAt);
    if (!catalogResults) throw new AttestationStopError("database evidence was not read through the constructed client");
    const catalog = mapCatalog(catalogResults);
    await reviewReadOnlyPreflight({
      pooledUrl: input.pooledUrl,
      directUrl: input.directUrl,
      readCatalog: () => catalog,
    });
    return renderAttestation({
      token: opened.token,
      transportApproved,
      clockInjected,
    });
  } catch (error) {
    failure = preserveOrClassify(error, "DATABASE_TRANSACTION_START");
    throw failure;
  } finally {
    if (client) {
      try {
        await client.disconnect();
      } catch (closeError) {
        if (failure === undefined) throw preserveOrClassify(closeError, "CLIENT_DISCONNECT");
      }
    }
  }
}

/**
 * Constructs a Prisma 7 client on the Neon WebSocket adapter.
 * Not called on import. Tests must inject openPrisma instead of calling this.
 * Installed @prisma/adapter-neon 7.10.0 startTransaction sends BEGIN on one
 * pool connection and routes later queries through that same NeonTransaction.
 * Its commit() and rollback() only release the connection; they send no SQL.
 * ROLLBACK is therefore sent on that session before release so the connection
 * is not returned still inside BEGIN. Adapter commit() after that sends no
 * second completion statement. Whether the query engine emits a preamble
 * before the callback is not proven without a live session.
 */
export async function openAttestorPrismaClient(input: { readonly pooledUrl: string }): Promise<AttestorPrismaClient> {
  const connectionString = connectionStringForPrisma(input.pooledUrl);
  assertEffectiveTls(new Client({ connectionString, ssl: { rejectUnauthorized: true } }));
  const token = {};
  constructedClients.add(token);
  const adapter = new PrismaNeon({
    connectionString,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: PREFLIGHT_CONNECTION_TIMEOUT_MS,
  });
  const prisma = new PrismaClient({ adapter });
  return {
    token,
    async runReadOnly(work) {
      try {
        await prisma.$transaction(async (tx) => {
          const bound: AttestorTx = {
            token,
            async execute(sql: string) {
              await tx.$executeRawUnsafe(sql);
            },
            async query(sql: string) {
              const rows = await tx.$queryRawUnsafe(sql);
              if (!Array.isArray(rows)) throw new AttestationStopError("catalog row is malformed");
              return { rows: rows as Record<string, unknown>[] };
            },
          };
          await work(bound);
        }, {
          maxWait: PREFLIGHT_CONNECTION_TIMEOUT_MS,
          timeout: PREFLIGHT_STATEMENT_TIMEOUT_MS,
        });
      } catch (error) {
        throw preserveOrClassify(error, "DATABASE_TRANSACTION_START");
      }
    },
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}

async function readApprovedApi(token: string, fetchImpl: NeonApiFetch): Promise<void> {
  try {
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
    const comparison = compareObservedIdentities(evidence);
    if (comparison.parentApproval !== "PENDING") throw new AttestationStopError("discovery tool approval is not operator approval");
    if (comparison.mismatchCount !== 0) throw new AttestationStopError("Neon API identity does not match the approved rehearsal target");
    if (evidence.child.status !== "present" || evidence.child.id !== OPERATOR_OBSERVED.childBranchId) {
      throw new AttestationStopError("API child branch does not match the approved child");
    }
    const childEndpoint = evidence.endpoints.find((row) => row.endpointId === OPERATOR_OBSERVED.childEndpointId);
    if (!childEndpoint || childEndpoint.role !== "child" || childEndpoint.branchId !== OPERATOR_OBSERVED.childBranchId) {
      throw new AttestationStopError("API endpoint mapping does not contain the rehearsal child");
    }
  } catch (error) {
    if (error instanceof AttestationStopError) throw error;
    if (error instanceof DiscoveryStopError) {
      const detail = error.message.replace(/^STOP: /, "");
      if (/postgres(ql)?:\/\//i.test(detail) || /:[^:@/\s]+@/.test(detail) || detail.includes("Bearer ")) {
        throw new AttestationStopError("Neon API request failed");
      }
      throw new AttestationStopError(detail);
    }
    throw classifyDriverFailure("API_METADATA", error);
  }
}

function assertBoundTimestamps(apiObservedAt: string, dbObservedAt: string, evaluatedAt: string): void {
  const api = Date.parse(apiObservedAt);
  const db = Date.parse(dbObservedAt);
  const current = Date.parse(evaluatedAt);
  if (!Number.isFinite(api) || !Number.isFinite(db) || !Number.isFinite(current)) {
    throw new AttestationStopError("attestation evidence is missing");
  }
  if (current - api < 0 || current - db < 0) throw new AttestationStopError("attestation evidence is in the future");
  if (current - api > ATTESTATION_MAX_AGE_MS || current - db > ATTESTATION_MAX_AGE_MS) {
    throw new AttestationStopError("attestation evidence is stale");
  }
  if (db < api || db - api > ATTESTATION_MAX_AGE_MS) throw new AttestationStopError("attestation timestamps are inconsistent");
}

function assertServerProof(result: PreflightQueryResult): void {
  if (result.rows.length !== 1) throw new AttestationStopError("PostgreSQL session is not read-only");
  const row = result.rows[0];
  if (!row) throw new AttestationStopError("PostgreSQL session is not read-only");
  if (row.transaction_read_only !== "on") throw new AttestationStopError("PostgreSQL session is not read-only");
  if (row.role_name !== ATTESTOR_ROLE) throw new AttestationStopError("PostgreSQL role is not the dedicated read-only role");
  for (const flag of [row.rolsuper, row.rolbypassrls, row.rolcreatedb, row.rolcreaterole]) {
    if (flag !== false) throw new AttestationStopError("PostgreSQL role is not restricted");
  }
}

function assertAttestorUrls(pooledUrl: string, directUrl: string): void {
  let pooledUser = "";
  let directUser = "";
  try {
    pooledUser = decodeURIComponent(new URL(pooledUrl).username);
    directUser = decodeURIComponent(new URL(directUrl).username);
    assertReadOnlyChildUrls(pooledUrl, directUrl);
  } catch (error) {
    if (error instanceof AttestationStopError) throw error;
    if (error instanceof PreflightStopError) throw new AttestationStopError(error.message.replace(/^STOP: /, ""));
    throw new AttestationStopError("a Neon URL is malformed");
  }
  if (pooledUser !== ATTESTOR_ROLE || directUser !== ATTESTOR_ROLE) {
    throw new AttestationStopError("PostgreSQL role is not the dedicated read-only role");
  }
}

function renderAttestation(input: {
  token: object;
  transportApproved: boolean;
  clockInjected: boolean;
}): ConnectionBoundAttestation {
  const constructed = constructedClients.has(input.token);
  const evidenceClass = constructed ? "attestor-constructed" : "injected-fixture";
  const liveEvidence = classifyLiveEvidence({
    clientConstructed: constructed,
    transportApproved: input.transportApproved,
    clockInjected: input.clockInjected,
  });
  const text = [
    "kind: stage17-connection-bound-attestation",
    "connectionBoundChecks: passed",
    "neonApiEndpointOwnership: verified",
    "databaseSessionIdentity: verified",
    "operatorApprovalForLaterOperations: required",
    `evidenceClass: ${evidenceClass}`,
    `liveEvidence: ${liveEvidence}`,
    "apiAttestation: not-approved",
    "writeAuthority: none",
    "cleanupAuthorized: false",
    "loadAuthorized: false",
    "productionWriteAuthority: none",
    `endpointId: ${OPERATOR_OBSERVED.childEndpointId}`,
    "databaseName: neondb",
    `role: ${ATTESTOR_ROLE}`,
  ].join("\n");
  if (/postgres(ql)?:\/\//i.test(text) || /:[^:@/\s]+@/.test(text) || text.includes("Bearer ")) {
    throw new AttestationStopError("attestation report contains a credential");
  }
  return {
    kind: "stage17-connection-bound-attestation",
    connectionBoundChecks: "passed",
    neonApiEndpointOwnership: "verified",
    databaseSessionIdentity: "verified",
    operatorApprovalForLaterOperations: "required",
    evidenceClass,
    liveEvidence,
    apiAttestation: "not-approved",
    writeAuthority: "none",
    cleanupAuthorized: false,
    loadAuthorized: false,
    productionWriteAuthority: "none",
    report: `${text}\n`,
  };
}

async function phaseStep<T>(phase: AttestorFailurePhase, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw preserveOrClassify(error, phase);
  }
}

function preserveOrClassify(error: unknown, phase: AttestorFailurePhase): Error {
  const unwrapped = unwrapAttestorError(error);
  if (unwrapped instanceof AttestationStopError || unwrapped instanceof PreflightTimeoutError) return unwrapped;
  if (unwrapped instanceof Error && unwrapped.name === "PreflightStopError") return unwrapped;
  if (isTimeout(unwrapped)) return new PreflightTimeoutError();
  return classifyDriverFailure(phase, unwrapped);
}

export function classifyDriverFailure(phase: AttestorFailurePhase, error: unknown): AttestationStopError {
  const category = safeDriverCategory(error);
  return new AttestationStopError(`attestation failed phase ${phase} category ${category}`);
}

function unwrapAttestorError(error: unknown): unknown {
  if (error instanceof AttestationStopError || error instanceof PreflightTimeoutError) return error;
  if (typeof error !== "object" || error === null || !("cause" in error)) return error;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof AttestationStopError || cause instanceof PreflightTimeoutError) return cause;
  return error;
}

function safeDriverCategory(error: unknown): string {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  let prismaCode: string | undefined;
  let nativeType = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const record = current as { code?: unknown; originalCode?: unknown; name?: unknown; cause?: unknown; meta?: unknown; driverAdapterError?: unknown; kind?: unknown };
    const direct = driverCode(record.originalCode) ?? driverCode(record.code);
    if (direct && !direct.startsWith("P")) return direct;
    if (direct && prismaCode === undefined) prismaCode = direct;
    if (record.kind === "UnsupportedNativeDataType") nativeType = true;
    if (record.name === "TimeoutError") return "timeout";
    pending.push(record.meta, record.driverAdapterError, record.cause);
  }
  if (nativeType) return "nativetype";
  return prismaCode ?? "unclassified";
}

function driverCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_DRIVER_CODES.has(value) ? value : undefined;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "57014" || code === "ETIMEDOUT") return true;
  if (error.name === "TimeoutError") return true;
  return /timeout/i.test(error.message) && !/postgres(ql)?:\/\//i.test(error.message) && !/:[^:@/\s]+@/.test(error.message);
}

const SSL_QUERY_KEYS = new Set(["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"]);
const ALLOWED_SSLMODE = new Set(["require", "verify-full"]);

function connectionStringForPrisma(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AttestationStopError("a Neon URL is malformed");
  }
  const sslKeys = [...url.searchParams.keys()].filter((key) => SSL_QUERY_KEYS.has(key.toLowerCase()));
  if (sslKeys.length === 0) return raw;
  for (const key of sslKeys) {
    const name = key.toLowerCase();
    const value = (url.searchParams.get(key) ?? "").toLowerCase();
    if (name === "sslmode" && ALLOWED_SSLMODE.has(value)) continue;
    throw new AttestationStopError("TLS certificate verification is required");
  }
  for (const key of sslKeys) url.searchParams.delete(key);
  return url.toString();
}

function assertEffectiveTls(client: Client): void {
  const ssl = (client as { connectionParameters?: { ssl?: unknown } }).connectionParameters?.ssl;
  if (!ssl || typeof ssl !== "object" || Array.isArray(ssl)) {
    throw new AttestationStopError("TLS certificate verification is required");
  }
  const record = ssl as { rejectUnauthorized?: unknown; checkServerIdentity?: unknown };
  if (record.rejectUnauthorized !== true || typeof record.checkServerIdentity === "function") {
    throw new AttestationStopError("TLS certificate verification is required");
  }
}
