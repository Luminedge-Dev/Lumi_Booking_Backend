// Stage 17 pg client bridge. Importing this file does not connect.
// The client is created only when the factory is called with an execution-time direct URL.
// TLS certificate verification stays enabled. Driver errors are not returned with their original text.

import { Client } from "pg";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";
import {
  PREFLIGHT_CONNECTION_TIMEOUT_MS,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
  PreflightTimeoutError,
  type PreflightConnectInput,
  type PreflightQueryResult,
} from "./readonly-preflight-adapter";
import { PREFLIGHT_CHILD_ENDPOINT_ID, PreflightStopError } from "./readonly-preflight";
import { PRODUCTION_ENDPOINT_FRAGMENT, STAGE13_DEV_ENDPOINT_ID } from "./rehearsal-guard";
import type { ReadOnlyClientFactory, ReadOnlySqlClient } from "./readonly-runtime-connector";

const BLOCKED_ROLES = new Set(["postgres", "neondb_owner", "neon_superuser"]);

export interface PgClientConfig {
  readonly connectionString: string;
  readonly connectionTimeoutMillis: typeof PREFLIGHT_CONNECTION_TIMEOUT_MS;
  readonly query_timeout: typeof PREFLIGHT_STATEMENT_TIMEOUT_MS;
  readonly statement_timeout: typeof PREFLIGHT_STATEMENT_TIMEOUT_MS;
  readonly ssl: { readonly rejectUnauthorized: true };
}

export interface PgLikeClient {
  connect(): Promise<void>;
  query(statement: string): Promise<{ rows: unknown }>;
  end(): Promise<void>;
}

export function createPgReadOnlyClientFactory(deps: {
  expectedRole: string;
  createClient?: (config: PgClientConfig) => PgLikeClient;
} ): ReadOnlyClientFactory {
  return (input) => openPgReadOnlyClient(input, deps);
}

export async function openPgReadOnlyClient(input: PreflightConnectInput, deps: {
  expectedRole: string;
  createClient?: (config: PgClientConfig) => PgLikeClient;
}): Promise<ReadOnlySqlClient> {
  assertDirectChild(input, deps.expectedRole);
  const config: PgClientConfig = {
    connectionString: directUrlForClient(input.connectionString),
    connectionTimeoutMillis: PREFLIGHT_CONNECTION_TIMEOUT_MS,
    query_timeout: PREFLIGHT_STATEMENT_TIMEOUT_MS,
    statement_timeout: PREFLIGHT_STATEMENT_TIMEOUT_MS,
    ssl: { rejectUnauthorized: true },
  };
  // pg copies connectionString over the ssl object. Inspect that result before connect.
  assertEffectiveTls(new Client(config));
  const client = deps.createClient ? deps.createClient(config) : new Client(config);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw sanitizeDriverError(error);
  }
  return {
    async query(statement: string): Promise<PreflightQueryResult> {
      try {
        const result = await client.query(statement);
        if (!Array.isArray(result.rows)) throw new PreflightStopError("catalog row is malformed");
        return { rows: result.rows as Record<string, unknown>[] };
      } catch (error) {
        throw sanitizeDriverError(error);
      }
    },
    async end(): Promise<void> {
      try {
        await client.end();
      } catch (error) {
        throw sanitizeDriverError(error);
      }
    },
  };
}

function assertDirectChild(input: PreflightConnectInput, expectedRole: string): void {
  if (input.readOnly !== true) throw new PreflightStopError("PostgreSQL session is not read-only");
  if (input.connectionTimeoutMs !== PREFLIGHT_CONNECTION_TIMEOUT_MS) throw new PreflightStopError("connection timeout is outside the preflight bound");
  if (input.statementTimeoutMs !== PREFLIGHT_STATEMENT_TIMEOUT_MS) throw new PreflightStopError("statement timeout is outside the preflight bound");
  let classified;
  let endpointId = "";
  let username = "";
  try {
    classified = classifyDatabaseUrl(input.connectionString);
    endpointId = normalizedEndpointId(input.connectionString);
    username = decodeURIComponent(new URL(input.connectionString).username);
  } catch {
    throw new PreflightStopError("a Neon URL is malformed");
  }
  if (classified.provider !== "neon" || classified.pooled || classified.database !== "neondb") {
    throw new PreflightStopError("the direct URL is not the rehearsal child");
  }
  if (endpointId === STAGE13_DEV_ENDPOINT_ID || endpointId.includes(PRODUCTION_ENDPOINT_FRAGMENT) || endpointId !== PREFLIGHT_CHILD_ENDPOINT_ID) {
    throw new PreflightStopError("the direct URL is not the rehearsal child");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(expectedRole) || BLOCKED_ROLES.has(expectedRole) || username !== expectedRole) {
    throw new PreflightStopError("PostgreSQL role is not the dedicated read-only role");
  }
}

const SSL_QUERY_KEYS = new Set(["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"]);
const ALLOWED_SSLMODE = new Set(["require", "verify-full"]);

function directUrlForClient(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreflightStopError("a Neon URL is malformed");
  }
  const sslKeys = [...url.searchParams.keys()].filter((key) => SSL_QUERY_KEYS.has(key.toLowerCase()));
  if (sslKeys.length === 0) return raw;
  for (const key of sslKeys) {
    const name = key.toLowerCase();
    const value = (url.searchParams.get(key) ?? "").toLowerCase();
    if (name === "sslmode" && ALLOWED_SSLMODE.has(value)) continue;
    throw new PreflightStopError("TLS certificate verification is required");
  }
  for (const key of sslKeys) url.searchParams.delete(key);
  return url.toString();
}

function assertEffectiveTls(client: Client): void {
  const ssl = (client as { connectionParameters?: { ssl?: unknown } }).connectionParameters?.ssl;
  if (!ssl || typeof ssl !== "object" || Array.isArray(ssl)) {
    throw new PreflightStopError("TLS certificate verification is required");
  }
  const record = ssl as { rejectUnauthorized?: unknown; checkServerIdentity?: unknown };
  if (record.rejectUnauthorized !== true || typeof record.checkServerIdentity === "function") {
    throw new PreflightStopError("TLS certificate verification is required");
  }
}

function sanitizeDriverError(error: unknown): Error {
  if (error instanceof PreflightStopError || error instanceof PreflightTimeoutError) return error;
  if (isTimeout(error)) return new PreflightTimeoutError();
  return new PreflightStopError("PostgreSQL driver failed");
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "57014" || code === "ETIMEDOUT") return true;
  if (error.name === "TimeoutError") return true;
  return /timeout/i.test(error.message) && !/postgres(ql)?:\/\//i.test(error.message) && !/:[^:@/\s]+@/.test(error.message);
}
