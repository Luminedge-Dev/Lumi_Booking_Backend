// Stage 17 cleanup planner. It renders one fixed statement and checks
// caller-supplied preconditions. It does not open a connection, execute SQL,
// or grant execution authority.
//
// Before any future execution, Slice F must supply independently verified
// live reads: the child endpoint from the connection, current_database()
// equal to neondb, pg_constraint referencers of these tables, and the
// sessions/accounts/verifications census. Fixture objects are not those reads.

import { STAGE13_DEV_ENDPOINT_ID, isValidatedRehearsalFacts, type ValidatedRehearsalFacts } from "./rehearsal-guard";

export const CLEANUP_ALLOWLIST = [
  "sessions",
  "accounts",
  "verifications",
  "users",
  "mock_allocations",
  "teacher_assignments",
  "feedback_entries",
  "feedback_status",
  "admin_sections",
  "trf_emails",
  "trf_email_history",
  "courses",
  "schedules",
  "schedule_slots",
  "slot_counters",
  "bookings",
] as const;

export type CleanupTable = (typeof CLEANUP_ALLOWLIST)[number];

const ALLOWED = new Set<string>(CLEANUP_ALLOWLIST);

export const CLEANUP_LIVE_EVIDENCE = [
  "child endpoint id from the verified connection",
  "current_database() equals neondb",
  "pg_constraint referencers of allowlist tables",
  "sessions, accounts, and verifications counts",
] as const;

export interface ForeignKeyReferencer {
  referencingTable: string;
  referencedTable: string;
}

export interface IdentityCensus {
  sessions: number;
  accounts: number;
  verifications: number;
}

export interface AllowlistStatement {
  sql: string;
  tables: readonly CleanupTable[];
}

/** A precondition review. `executionAuthority` is fixed and is not a grant to run the statement. */
export interface CleanupAssessment {
  readonly executionAuthority: "none";
  readonly liveEvidence: "not-attested";
  readonly statementPreview: string;
  readonly tables: readonly CleanupTable[];
}

export class AllowlistStopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "AllowlistStopError";
  }
}

function quoteAllowlisted(name: CleanupTable): string {
  if (!ALLOWED.has(name) || !/^[a-z_]+$/.test(name)) throw new AllowlistStopError("cleanup identifier is not on the allowlist");
  return `public.${name}`;
}

export function renderAllowlistSql(): AllowlistStatement {
  const sql = `TRUNCATE TABLE ${CLEANUP_ALLOWLIST.map((name) => quoteAllowlisted(name)).join(", ")}`;
  if (/\bCASCADE\b|\bDROP\b/i.test(sql)) throw new AllowlistStopError("cleanup SQL contains a forbidden clause");
  return { sql, tables: CLEANUP_ALLOWLIST };
}

export function assessCleanup(input: {
  facts: ValidatedRehearsalFacts;
  referencers: readonly ForeignKeyReferencer[];
  identity: IdentityCensus;
}): CleanupAssessment {
  if (!isValidatedRehearsalFacts(input.facts)) throw new AllowlistStopError("cleanup review requires validated rehearsal facts");
  if (input.facts.authority !== "none") throw new AllowlistStopError("rehearsal facts cannot carry write authority");
  if (input.facts.endpointId === STAGE13_DEV_ENDPOINT_ID || input.facts.endpointId.includes("falling-brook")) {
    throw new AllowlistStopError("stage13-dev and production endpoints cannot be cleanup targets");
  }
  if (input.identity.sessions !== 0 || input.identity.accounts !== 0 || input.identity.verifications !== 0) {
    throw new AllowlistStopError("identity tables are not empty");
  }
  for (const referencer of input.referencers) {
    if (ALLOWED.has(referencer.referencedTable) && !ALLOWED.has(referencer.referencingTable)) {
      throw new AllowlistStopError("a foreign-key referencer is outside the cleanup allowlist");
    }
  }
  const statement = renderAllowlistSql();
  return {
    executionAuthority: "none",
    liveEvidence: "not-attested",
    statementPreview: statement.sql,
    tables: statement.tables,
  };
}

/** Live cleanup execution is unavailable until Slice F attests the connection. */
export function authorizeCleanupExecution(): never {
  throw new AllowlistStopError("cleanup execution requires a live Neon attestation, which is not available");
}
