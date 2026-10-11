// Stage 17 read-only runtime connector.
// Importing this file does not open a database and does not read application configuration.
// A caller supplies the session client at execution time. This module does not construct pg,
// Prisma, or a Neon client, and it does not provision a role.
// D-041 parent approval is external evidence. This connector does not attest the API and does not grant a write.
// The setup statements are accepted for restricted inspection and still wait for grant confirmation.

import {
  PREFLIGHT_CONNECTION_TIMEOUT_MS,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
  PreflightTimeoutError,
  type PreflightConnect,
  type PreflightConnectInput,
  type PreflightQueryResult,
  type PreflightSession,
} from "./readonly-preflight-adapter";
import { PREFLIGHT_STATEMENTS, PreflightStopError, assertReadOnlyChildUrls } from "./readonly-preflight";
import {
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_PROOF_SQL,
  READ_ONLY_ROLLBACK_SQL,
  READ_ONLY_TRANSACTION_PROOF,
  readOnlyStatementTimeoutSql,
} from "./readonly-session-contract";

const APPROVED_SQL = new Set<string>(PREFLIGHT_STATEMENTS);
const BLOCKED_ROLES = new Set(["postgres", "neondb_owner", "neon_superuser"]);

export interface ReadOnlySqlClient {
  query(statement: string): Promise<PreflightQueryResult>;
  end(): Promise<void>;
}

export interface ReadOnlyClientFactory {
  (input: PreflightConnectInput): Promise<ReadOnlySqlClient>;
}

export function createReadOnlyRuntimeConnector(input: {
  pooledUrl: string;
  directUrl: string;
  readOnlyRole: string;
  openClient: ReadOnlyClientFactory;
}): PreflightConnect {
  assertDedicatedRole(input.readOnlyRole);
  return async (connectInput) => {
    assertReadOnlyChildUrls(input.pooledUrl, input.directUrl);
    if (connectInput.connectionString !== input.directUrl) throw new PreflightStopError("the direct URL does not match the reviewed target");
    if (connectInput.readOnly !== true) throw new PreflightStopError("PostgreSQL session is not read-only");
    if (connectInput.connectionTimeoutMs !== PREFLIGHT_CONNECTION_TIMEOUT_MS) throw new PreflightStopError("connection timeout is outside the preflight bound");
    if (connectInput.statementTimeoutMs !== PREFLIGHT_STATEMENT_TIMEOUT_MS) throw new PreflightStopError("statement timeout is outside the preflight bound");
    let client: ReadOnlySqlClient | undefined;
    try {
      client = await input.openClient(connectInput);
      return new ReadOnlyRuntimeSession(client, input.readOnlyRole);
    } catch (error) {
      if (client) await client.end().catch(() => undefined);
      throw sanitizeDriverError(error);
    }
  };
}

class ReadOnlyRuntimeSession implements PreflightSession {
  private started = false;
  private closed = false;

  constructor(
    private readonly client: ReadOnlySqlClient,
    private readonly readOnlyRole: string,
  ) {}

  async startReadOnlyTransaction(): Promise<{ kind: typeof READ_ONLY_TRANSACTION_PROOF }> {
    if (this.closed || this.started) throw new PreflightStopError("PostgreSQL read-only transaction setup failed");
    this.started = true;
    await this.send(READ_ONLY_BEGIN_SQL);
    await this.send(readOnlyStatementTimeoutSql(PREFLIGHT_STATEMENT_TIMEOUT_MS));
    const proof = await this.send(READ_ONLY_PROOF_SQL);
    assertServerProof(proof, this.readOnlyRole);
    return { kind: READ_ONLY_TRANSACTION_PROOF };
  }

  async query(statement: string): Promise<PreflightQueryResult> {
    if (!this.started || this.closed) throw new PreflightStopError("PostgreSQL session is not read-only");
    if (!APPROVED_SQL.has(statement)) throw new PreflightStopError("SQL is outside the preflight statement list");
    return this.send(statement);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    try {
      if (this.started) await this.client.query(READ_ONLY_ROLLBACK_SQL);
    } catch (error) {
      failure = sanitizeDriverError(error);
    }
    try {
      await this.client.end();
    } catch (error) {
      if (failure === undefined) failure = sanitizeDriverError(error);
    }
    if (failure) throw failure;
  }

  private async send(statement: string): Promise<PreflightQueryResult> {
    try {
      return await this.client.query(statement);
    } catch (error) {
      throw sanitizeDriverError(error);
    }
  }
}

function assertDedicatedRole(role: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(role) || BLOCKED_ROLES.has(role)) {
    throw new PreflightStopError("PostgreSQL role is not the dedicated read-only role");
  }
}

function assertServerProof(result: PreflightQueryResult, expectedRole: string): void {
  const rows = result.rows;
  if (!Array.isArray(rows) || rows.length !== 1) throw new PreflightStopError("PostgreSQL session is not read-only");
  const row = rows[0];
  if (!row) throw new PreflightStopError("PostgreSQL session is not read-only");
  if (row.transaction_read_only !== "on") throw new PreflightStopError("PostgreSQL session is not read-only");
  if (row.role_name !== expectedRole) throw new PreflightStopError("PostgreSQL role is not the dedicated read-only role");
  for (const flag of [row.rolsuper, row.rolbypassrls, row.rolcreatedb, row.rolcreaterole]) {
    if (flag !== false) throw new PreflightStopError("PostgreSQL role is not restricted");
  }
}

function sanitizeDriverError(error: unknown): Error {
  if (error instanceof PreflightStopError || error instanceof PreflightTimeoutError) return error;
  if (isTimeout(error)) return new PreflightTimeoutError();
  return new Error("PostgreSQL driver failed");
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "57014" || code === "ETIMEDOUT") return true;
  return error.name === "TimeoutError";
}
