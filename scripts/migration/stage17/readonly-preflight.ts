// Stage 17 read-only child preflight. Importing this file does not open a database.
// URL classification is checked first and is not proof of a live connection.
// A caller must supply the catalog. This module does not read NEON_DB_URL or construct a client.
// A passing review does not approve the parent branch, attest the API, or grant a write.

import { CLEANUP_ALLOWLIST } from "./allowlist";
import { PRODUCTION_ENDPOINT_FRAGMENT, STAGE13_DEV_ENDPOINT_ID } from "./rehearsal-guard";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";

export const PREFLIGHT_CHILD_ENDPOINT_ID = "ep-dark-brook-b4atip73";

export const PREFLIGHT_STATEMENTS = [
  "SELECT current_database()",
  "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
  "SELECT src_ns.nspname AS referencing_schema, src.relname AS referencing_table, dst_ns.nspname AS referenced_schema, dst.relname AS referenced_table FROM pg_constraint con JOIN pg_class src ON src.oid = con.conrelid JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace JOIN pg_class dst ON dst.oid = con.confrelid JOIN pg_namespace dst_ns ON dst_ns.oid = dst.relnamespace WHERE con.contype = 'f'",
  "SELECT count(*) FROM public.sessions",
  "SELECT count(*) FROM public.accounts",
  "SELECT count(*) FROM public.verifications",
] as const;

const IDENTIFIER = /^[a-z_]+$/;

export class PreflightStopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "PreflightStopError";
  }
}

export interface PreflightForeignKey {
  referencingSchema: string;
  referencingTable: string;
  referencedSchema: string;
  referencedTable: string;
}

export interface PreflightCatalog {
  databaseName: string;
  publicTables: readonly string[];
  foreignKeys: readonly PreflightForeignKey[];
  sessions: number;
  accounts: number;
  verifications: number;
}

export interface PreflightReport {
  readonly kind: "stage17-readonly-preflight";
  readonly parentApproval: "PENDING";
  readonly apiAttestation: "not-approved";
  readonly writeAuthority: "none";
  readonly liveConnection: "catalog-supplied";
  readonly urlClassification: "not-connection-proof";
  readonly endpointId: typeof PREFLIGHT_CHILD_ENDPOINT_ID;
  readonly databaseName: "neondb";
  readonly report: string;
}

export async function reviewReadOnlyPreflight(input: {
  pooledUrl: string;
  directUrl: string;
  readCatalog?: () => Promise<PreflightCatalog> | PreflightCatalog;
}): Promise<PreflightReport> {
  const endpointId = assertReadOnlyChildUrls(input.pooledUrl, input.directUrl);
  if (!input.readCatalog) throw new PreflightStopError("URL classification is not a live connection");
  const catalog = await input.readCatalog();
  assertCatalog(catalog);
  const report = renderPreflightReport(endpointId, catalog);
  return {
    kind: "stage17-readonly-preflight",
    parentApproval: "PENDING",
    apiAttestation: "not-approved",
    writeAuthority: "none",
    liveConnection: "catalog-supplied",
    urlClassification: "not-connection-proof",
    endpointId,
    databaseName: "neondb",
    report,
  };
}

export function assertReadOnlyChildUrls(pooledUrl: string, directUrl: string): typeof PREFLIGHT_CHILD_ENDPOINT_ID {
  let pooled;
  let direct;
  try {
    pooled = classifyDatabaseUrl(pooledUrl);
    direct = classifyDatabaseUrl(directUrl);
  } catch {
    throw new PreflightStopError("a Neon URL is malformed");
  }
  if (pooled.provider !== "neon" || direct.provider !== "neon") throw new PreflightStopError("targets must be Neon PostgreSQL endpoints");
  if (!pooled.pooled || direct.pooled) throw new PreflightStopError("the pooled URL and the direct URL do not form a pooled/direct pair");
  if (pooled.database !== "neondb" || direct.database !== "neondb") throw new PreflightStopError("database name is not neondb");
  const pooledId = normalizedEndpointId(pooledUrl);
  const directId = normalizedEndpointId(directUrl);
  if (pooledId !== directId) throw new PreflightStopError("pooled and direct endpoints differ");
  if (pooledId === STAGE13_DEV_ENDPOINT_ID) throw new PreflightStopError("stage13-dev is not a rehearsal target");
  if (pooledId.includes(PRODUCTION_ENDPOINT_FRAGMENT)) throw new PreflightStopError("a production endpoint was detected");
  if (pooledId !== PREFLIGHT_CHILD_ENDPOINT_ID) throw new PreflightStopError("endpoint id is not the rehearsal child");
  return PREFLIGHT_CHILD_ENDPOINT_ID;
}

function assertCatalog(catalog: PreflightCatalog): void {
  if (catalog.databaseName !== "neondb") throw new PreflightStopError("current_database() is not neondb");
  const present = new Set(catalog.publicTables);
  const missing = CLEANUP_ALLOWLIST.filter((table) => !present.has(table));
  if (missing.length > 0) throw new PreflightStopError("allowlist table is missing");
  const allowed = new Set<string>(CLEANUP_ALLOWLIST);
  for (const key of catalog.foreignKeys) {
    if (!IDENTIFIER.test(key.referencingSchema) || !IDENTIFIER.test(key.referencedSchema)) {
      throw new PreflightStopError("foreign-key schema is malformed");
    }
    if (!IDENTIFIER.test(key.referencingTable) || !IDENTIFIER.test(key.referencedTable)) {
      throw new PreflightStopError("foreign-key name is malformed");
    }
    const referencesPublicAllowlist = key.referencedSchema === "public" && allowed.has(key.referencedTable);
    const referencingPublicAllowlist = key.referencingSchema === "public" && allowed.has(key.referencingTable);
    if (referencesPublicAllowlist && !referencingPublicAllowlist) {
      throw new PreflightStopError("a foreign-key referencer is outside the cleanup allowlist");
    }
  }
  for (const count of [catalog.sessions, catalog.accounts, catalog.verifications]) {
    if (!Number.isInteger(count) || count < 0) throw new PreflightStopError("identity count is malformed");
  }
  if (catalog.sessions !== 0 || catalog.accounts !== 0 || catalog.verifications !== 0) {
    throw new PreflightStopError("identity tables are not empty");
  }
}

function renderPreflightReport(endpointId: typeof PREFLIGHT_CHILD_ENDPOINT_ID, catalog: PreflightCatalog): string {
  const text = [
    "kind: stage17-readonly-preflight",
    "parentApproval: PENDING",
    "apiAttestation: not-approved",
    "writeAuthority: none",
    "liveConnection: catalog-supplied",
    "urlClassification: not-connection-proof",
    `endpointId: ${endpointId}`,
    "databaseName: neondb",
    `currentDatabase: ${catalog.databaseName}`,
    "missingAllowlistTables: none",
    `identityCounts: sessions ${catalog.sessions} accounts ${catalog.accounts} verifications ${catalog.verifications}`,
    "cleanupAuthorized: false",
  ].join("\n");
  if (/postgres(ql)?:\/\//i.test(text) || /:[^:@/\s]+@/.test(text)) throw new PreflightStopError("preflight report contains a credential");
  return `${text}\n`;
}
