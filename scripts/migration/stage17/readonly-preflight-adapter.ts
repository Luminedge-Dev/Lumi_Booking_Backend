// Stage 17 read-only preflight execution adapter.
// Importing this file does not open a database and does not read application configuration.
// reviewReadOnlyPreflight owns URL and catalog validation. This adapter only supplies that review
// with a catalog read from an injected session, and only after that review accepts the URLs.
// A passing review does not approve the parent branch, attest the API, or grant a write.
// A caller-supplied read-only flag is not accepted as proof. Catalog queries run only after
// startReadOnlyTransaction returns the server-enforced proof. The SQL for that setup is not
// in this file; it stays pending approval in readonly-session-contract.ts. A failed attempt is not repeated.

import {
  PREFLIGHT_STATEMENTS,
  PreflightStopError,
  reviewReadOnlyPreflight,
  type PreflightCatalog,
  type PreflightForeignKey,
  type PreflightReport,
} from "./readonly-preflight";
import { isReadOnlyTransactionProof } from "./readonly-session-contract";

export const PREFLIGHT_CONNECTION_TIMEOUT_MS = 5_000;
export const PREFLIGHT_STATEMENT_TIMEOUT_MS = 10_000;

const APPROVED_SQL = new Set<string>(PREFLIGHT_STATEMENTS);

export class PreflightTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "PreflightTimeoutError";
  }
}

export interface PreflightQueryResult {
  rows: readonly Record<string, unknown>[];
}

export interface PreflightSession {
  startReadOnlyTransaction(): Promise<unknown>;
  query(statement: string): Promise<PreflightQueryResult>;
  close(): Promise<void>;
}

export interface PreflightConnectInput {
  readonly connectionString: string;
  readonly readOnly: true;
  readonly connectionTimeoutMs: typeof PREFLIGHT_CONNECTION_TIMEOUT_MS;
  readonly statementTimeoutMs: typeof PREFLIGHT_STATEMENT_TIMEOUT_MS;
}

export interface PreflightConnect {
  (input: PreflightConnectInput): Promise<PreflightSession>;
}

export async function executeReadOnlyPreflight(input: {
  pooledUrl: string;
  directUrl: string;
  connect: PreflightConnect;
}): Promise<PreflightReport> {
  return reviewReadOnlyPreflight({
    pooledUrl: input.pooledUrl,
    directUrl: input.directUrl,
    readCatalog: () => readCatalog(input.directUrl, input.connect),
  });
}

async function readCatalog(directUrl: string, connect: PreflightConnect): Promise<PreflightCatalog> {
  let session: PreflightSession | undefined;
  let phase: "connect" | "setup" | "query" = "connect";
  let failure: unknown;
  try {
    session = await connect({
      connectionString: directUrl,
      readOnly: true,
      connectionTimeoutMs: PREFLIGHT_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: PREFLIGHT_STATEMENT_TIMEOUT_MS,
    });
    phase = "setup";
    const proof = await session.startReadOnlyTransaction();
    if (!isReadOnlyTransactionProof(proof)) throw new PreflightStopError("PostgreSQL session is not read-only");
    phase = "query";
    const results: PreflightQueryResult[] = [];
    for (const statement of PREFLIGHT_STATEMENTS) {
      assertApprovedStatement(statement);
      results.push(await session.query(statement));
    }
    return mapCatalog(results);
  } catch (error) {
    failure = error;
    throw redact(error, phase);
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (closeError) {
        if (failure === undefined) throw redact(closeError, "close");
      }
    }
  }
}

function assertApprovedStatement(statement: string): void {
  if (!APPROVED_SQL.has(statement)) throw new PreflightStopError("SQL is outside the preflight statement list");
}

function redact(error: unknown, phase: "connect" | "setup" | "query" | "close"): PreflightStopError {
  if (error instanceof PreflightStopError) return error;
  if (error instanceof PreflightTimeoutError) {
    const message = phase === "connect"
      ? "PostgreSQL connection timed out"
      : phase === "setup"
        ? "PostgreSQL read-only transaction setup timed out"
        : phase === "query"
          ? "PostgreSQL query timed out"
          : "PostgreSQL connection close timed out";
    return new PreflightStopError(message);
  }
  const message = phase === "connect"
    ? "PostgreSQL connection failed"
    : phase === "setup"
      ? "PostgreSQL read-only transaction setup failed"
      : phase === "query"
        ? "PostgreSQL query failed"
        : "PostgreSQL connection close failed";
  return new PreflightStopError(message);
}

export function mapCatalog(results: readonly PreflightQueryResult[]): PreflightCatalog {
  if (results.length !== PREFLIGHT_STATEMENTS.length) throw new PreflightStopError("catalog row is malformed");
  return {
    databaseName: currentDatabase(results[0]),
    publicTables: publicTables(results[1]),
    foreignKeys: foreignKeys(results[2]),
    sessions: identityCount(results[3]),
    accounts: identityCount(results[4]),
    verifications: identityCount(results[5]),
  };
}

function currentDatabase(result: PreflightQueryResult | undefined): string {
  const row = oneRow(result);
  return bareIdentifier(row.current_database);
}

function publicTables(result: PreflightQueryResult | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows(result)) {
    if (row.nspname !== "public") throw new PreflightStopError("catalog row is malformed");
    const name = bareIdentifier(row.relname);
    if (seen.has(name)) throw new PreflightStopError("catalog row is malformed");
    seen.add(name);
    names.push(name);
  }
  return names;
}

function foreignKeys(result: PreflightQueryResult | undefined): PreflightForeignKey[] {
  return rows(result).map((row) => ({
    referencingSchema: schemaName(row.referencing_schema),
    referencingTable: bareIdentifier(row.referencing_table),
    referencedSchema: schemaName(row.referenced_schema),
    referencedTable: bareIdentifier(row.referenced_table),
  }));
}

function identityCount(result: PreflightQueryResult | undefined): number {
  const raw = oneRow(result).count;
  if (typeof raw === "bigint") return bigintCount(raw);
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d+$/.test(text)) throw new PreflightStopError("identity count is malformed");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new PreflightStopError("identity count is malformed");
  return value;
}

function bigintCount(raw: bigint): number {
  if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new PreflightStopError("identity count is malformed");
  return Number(raw);
}

function oneRow(result: PreflightQueryResult | undefined): Record<string, unknown> {
  const list = rows(result);
  if (list.length !== 1) throw new PreflightStopError("catalog row is malformed");
  return list[0] ?? {};
}

function rows(result: PreflightQueryResult | undefined): readonly Record<string, unknown>[] {
  if (!result || !Array.isArray(result.rows)) throw new PreflightStopError("catalog row is malformed");
  return result.rows;
}

function schemaName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z_]+$/.test(value)) throw new PreflightStopError("foreign-key schema is malformed");
  return value;
}

function bareIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z_]+$/.test(value)) throw new PreflightStopError("catalog row is malformed");
  return value;
}
