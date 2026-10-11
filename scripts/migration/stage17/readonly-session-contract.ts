// Stage 17 read-only connector requirements.
// This file does not open a database, read application configuration, or execute SQL.
// The statements below were accepted on 2026-10-10 for restricted inspection.
// Live execution still waits for confirmation of the dedicated role's grants.
// Importing this file does not run the statements.

export const READ_ONLY_TRANSACTION_PROOF = "server-enforced-read-only" as const;

export const READ_ONLY_TRANSACTION_SETUP_STATUS = "accepted-pending-grant-confirmation" as const;

export const READ_ONLY_BEGIN_SQL = "BEGIN READ ONLY";

export const READ_ONLY_ROLLBACK_SQL = "ROLLBACK";

export const READ_ONLY_PROOF_SQL = "SELECT current_setting('transaction_read_only') AS transaction_read_only, current_user AS role_name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user";

export function readOnlyStatementTimeoutSql(timeoutMs: number): string {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error("STOP: statement timeout is outside the preflight bound");
  }
  return `SET LOCAL statement_timeout = ${timeoutMs}`;
}

export const FUTURE_READ_ONLY_CONNECTOR_REQUIREMENTS = [
  "dedicated restricted PostgreSQL read-only role",
  "server-enforced read-only transaction before catalog queries",
  "query execution confined to the approved preflight statements",
  "enforced connection and statement timeouts",
  "transaction cleanup and connection closure on every path",
  "no automatic retries",
  "no credentials or connection strings in reports",
  "no application environment database URLs",
] as const;

export interface ReadOnlyTransactionProof {
  readonly kind: typeof READ_ONLY_TRANSACTION_PROOF;
}

export function isReadOnlyTransactionProof(value: unknown): value is ReadOnlyTransactionProof {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === READ_ONLY_TRANSACTION_PROOF;
}
