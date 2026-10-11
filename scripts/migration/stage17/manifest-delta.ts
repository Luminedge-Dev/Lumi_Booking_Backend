// Canonical-row delta for manifests produced by the Stage 14 expectation
// collector. This compares accepted canonical rows. It does not describe
// MongoDB document deletion.
//
// A root that was accepted and is later quarantined disappears from the
// canonical manifest. That is `canonicalRowsAbsent`, not a confirmed source
// deletion. Excluded source fields never become digest columns.
//
// Source-document identity lives in source-manifest.ts. It has its own digest
// version. A root quarantine is not a source deletion, and canonicalRowsAbsent
// is not a MongoDB deletion.
//
// Store stamped canonical manifests only under `_migration/stage17-manifests/`.
// `_migration/` is gitignored. Public reports contain counts only.

import type { TableManifest } from "../stage14/validate/expectation";
import type { TableName } from "../stage14/common";
import { TABLES } from "../stage14/common";

/** rowDigest = SHA-256 of canonicalJson(projected TABLE_SPECS columns), first 16 hex chars.
 * Absent and null collapse to the same JSON null. Comparison is string equality. */
export const MANIFEST_DIGEST_VERSION = "stage14-row-digest-v1" as const;

/** Reserved for a future source-document digest. Not produced by this module. */
export const SOURCE_IDENTITY_DELTA = {
  digestVersion: "source-identity-v1",
  sourceChanges: ["added", "modified", "deleted", "unchanged"],
  transformOutcomes: ["accepted", "root-quarantined"],
  status: "implemented",
  module: "scripts/migration/stage17/source-manifest.ts",
  rule: "Source deletion requires the identity to be absent from the later extract. Root quarantine is a separate outcome and is not a MongoDB deletion.",
} as const;

export const MANIFEST_PRODUCTION = {
  producer: "scripts/migration/stage14/pipeline.ts runPipeline",
  stamp: "stampExpectationManifest(pipeline.expectation.toManifest())",
  comparison: "canonical-rows",
  status: "not-executed-in-slice-c",
} as const;

/** Gitignored directory, relative to Lumi_Booking_Backend. Not created here. */
export const OFFLINE_MANIFEST_DIRECTORY = "_migration/stage17-manifests";

export interface DigestManifest {
  digestVersion: typeof MANIFEST_DIGEST_VERSION;
  tables: Partial<Record<TableName, Readonly<Record<string, string>>>>;
}

export interface TableDeltaCounts {
  table: TableName;
  canonicalRowsAdded: number;
  canonicalRowsUpdated: number;
  canonicalRowsAbsent: number;
  canonicalRowsUnchanged: number;
}

export interface ManifestDeltaReport {
  comparison: "canonical-rows";
  digestVersion: typeof MANIFEST_DIGEST_VERSION;
  interpretation: "A canonical row that is absent was not accepted by the transform. That is not a confirmed MongoDB deletion.";
  canonicalRowsAdded: number;
  canonicalRowsUpdated: number;
  canonicalRowsAbsent: number;
  canonicalRowsUnchanged: number;
  tables: TableDeltaCounts[];
}

export function stampExpectationManifest(manifest: TableManifest): DigestManifest {
  return { digestVersion: MANIFEST_DIGEST_VERSION, tables: manifest };
}

export function parseDigestManifest(value: unknown): DigestManifest {
  if (typeof value !== "object" || value === null) throw new Error("canonical manifest schema is incomplete");
  const body = value as Partial<DigestManifest>;
  if (body.digestVersion !== MANIFEST_DIGEST_VERSION) throw new Error("manifest digest version is not stage14-row-digest-v1");
  if (typeof body.tables !== "object" || body.tables === null) throw new Error("canonical manifest schema is incomplete");
  const tables: DigestManifest["tables"] = {};
  for (const table of TABLES) {
    const rows = body.tables[table];
    if (rows === undefined) continue;
    if (typeof rows !== "object" || rows === null || Array.isArray(rows)) throw new Error("canonical manifest schema is incomplete");
    for (const digest of Object.values(rows)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{16}$/.test(digest)) throw new Error("canonical manifest schema is incomplete");
    }
    tables[table] = rows;
  }
  return { digestVersion: MANIFEST_DIGEST_VERSION, tables };
}

export function assertGitignoredManifestPath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || !normalized.startsWith(`${OFFLINE_MANIFEST_DIRECTORY}/`)) {
    throw new Error("manifests must stay under the gitignored _migration/stage17-manifests directory");
  }
}

function tableDelta(earlier: Readonly<Record<string, string>>, later: Readonly<Record<string, string>>): Omit<TableDeltaCounts, "table"> {
  let canonicalRowsAdded = 0;
  let canonicalRowsUpdated = 0;
  let canonicalRowsAbsent = 0;
  let canonicalRowsUnchanged = 0;
  for (const [id, digest] of Object.entries(later)) {
    const previous = earlier[id];
    if (previous === undefined) canonicalRowsAdded += 1;
    else if (previous !== digest) canonicalRowsUpdated += 1;
    else canonicalRowsUnchanged += 1;
  }
  for (const id of Object.keys(earlier)) {
    if (later[id] === undefined) canonicalRowsAbsent += 1;
  }
  return { canonicalRowsAdded, canonicalRowsUpdated, canonicalRowsAbsent, canonicalRowsUnchanged };
}

export function classifyManifestDelta(earlier: DigestManifest, later: DigestManifest): ManifestDeltaReport {
  if (earlier.digestVersion !== MANIFEST_DIGEST_VERSION || later.digestVersion !== MANIFEST_DIGEST_VERSION) {
    throw new Error("manifest digest version is not stage14-row-digest-v1");
  }
  const tables: TableDeltaCounts[] = [];
  const totals = { canonicalRowsAdded: 0, canonicalRowsUpdated: 0, canonicalRowsAbsent: 0, canonicalRowsUnchanged: 0 };
  for (const table of TABLES) {
    const counts = tableDelta(earlier.tables[table] ?? {}, later.tables[table] ?? {});
    tables.push({ table, ...counts });
    totals.canonicalRowsAdded += counts.canonicalRowsAdded;
    totals.canonicalRowsUpdated += counts.canonicalRowsUpdated;
    totals.canonicalRowsAbsent += counts.canonicalRowsAbsent;
    totals.canonicalRowsUnchanged += counts.canonicalRowsUnchanged;
  }
  return {
    comparison: "canonical-rows",
    digestVersion: MANIFEST_DIGEST_VERSION,
    interpretation: "A canonical row that is absent was not accepted by the transform. That is not a confirmed MongoDB deletion.",
    ...totals,
    tables,
  };
}
