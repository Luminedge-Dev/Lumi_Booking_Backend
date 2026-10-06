// Stage 10.5 (D-031) -- shared types for the canonical data contract and
// normalization tooling. This file is deliberately standalone: nothing here
// imports from src/app/**, routes/**, or middleware/**, and nothing here is
// imported by the running application this stage (see
// tests/architecture/migration-tooling-boundary.test.ts).

/** Reuses Stage 6's existing classification taxonomy verbatim (see
 * context/database-normalization-policy.md) rather than inventing a new one. */
export type FieldClassification =
  | "PRESERVE"
  | "NORMALIZE_ON_READ"
  | "NORMALIZE_ON_WRITE_FOR_NEW_DATA"
  | "FUTURE_DATA_MIGRATION"
  | "INVESTIGATE"
  | "IGNORE_AS_HISTORICAL";

/** Closure-patch addition (D-031 addendum): decouples "what Stage 6's
 * taxonomy knows about this field" (classification) from "does it belong in
 * the final canonical DTO" (targetDisposition). A field can be
 * well-understood (PRESERVE) yet still excluded, or poorly-understood
 * (INVESTIGATE) yet still worth surfacing for review rather than silently
 * dropping. See the whole-document normalizers (*.normalizer.ts) for how
 * each disposition is applied. */
export type FieldTargetDisposition = "INCLUDE" | "EXCLUDE" | "QUARANTINE";

/** One row of a per-entity contract registry (tools/migration/*.contract.ts),
 * a typed mirror of context/canonical-data-contract.md's prose tables. */
export interface FieldContractEntry {
  field: string;
  classification: FieldClassification;
  targetDisposition: FieldTargetDisposition;
  canonicalType: string;
  required: boolean;
  nullable: boolean;
  /** e.g. [] for courses.homeBasedSystems when absent -- a data-shape
   * default grounded in an existing legitimate code path
   * (scripts/unset-home-based-systems.js), never an invented business rule. */
  defaultValue?: unknown;
  /** ONLY the fully-evidenced closed set for this field. Absent when the
   * enum is not (yet) closed by audit/code evidence. */
  enumValues?: readonly string[];
  referenceTarget?: "User" | "Course" | "Schedule";
  /** code-alias: a legacy field-name spelling confirmed only in application
   *  code (e.g. dateofbirth). data-variant: an observed mixed-BSON-type
   *  value confirmed in the real audited data (e.g. string|ObjectId). */
  aliasKind?: "code-alias" | "data-variant";
  hasNormalizer: boolean;
  /** Human-readable reject condition, for fields with a normalizer. */
  rejectPolicy?: string;
  notes?: string;
}

/** A transformation that was applied. Never carries the raw field value --
 * only type labels -- to avoid leaking PII (passwords, passport numbers,
 * emails) into migration reports. */
export interface NormalizationChange {
  field: string;
  observedType: string;
  canonicalType: string;
}

/** A value that was accepted as-is but falls outside what this stage's
 * evidence has fully characterized. PII-safe. */
export interface NormalizationWarning {
  field: string;
  code: string;
  message: string;
}

/** A value that could not be normalized at all. PII-safe: only the
 * observed BSON/JS type is recorded, never the value itself. `sourceId` is
 * the document's own _id (for triage), never the rejected field's value. */
export interface NormalizationError {
  field: string;
  code: string;
  message: string;
  observedType: string;
  sourceId?: string;
}

/** A field whose value was intentionally NOT written into the canonical
 * output and NOT discarded either -- surfaced here for manual review.
 * PII-safe: only the field name and observed type, never the raw value. */
export interface QuarantinedField {
  field: string;
  observedType: string;
  reason: string;
}

export type NormalizationResult<T> =
  | {
      ok: true;
      value: T;
      warnings: NormalizationWarning[];
      changes: NormalizationChange[];
      quarantined: QuarantinedField[];
    }
  | { ok: false; errors: NormalizationError[]; sourceId?: string };

export function ok<T>(
  value: T,
  warnings: NormalizationWarning[] = [],
  changes: NormalizationChange[] = [],
  quarantined: QuarantinedField[] = []
): NormalizationResult<T> {
  return { ok: true, value, warnings, changes, quarantined };
}

export function fail<T>(errors: NormalizationError[], sourceId?: string): NormalizationResult<T> {
  return { ok: false, errors, sourceId };
}
