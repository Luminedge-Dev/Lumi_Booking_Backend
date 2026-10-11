import { normalizeBookingDocument } from "../../../tools/migration/booking.normalizer";
import { normalizeCourseDocument } from "../../../tools/migration/course.normalizer";
import type { NormalizationResult } from "../../../tools/migration/migration.types";
import { normalizeScheduleDocument } from "../../../tools/migration/schedule.normalizer";
import { normalizeUserDocument } from "../../../tools/migration/user.normalizer";
import type { RawDoc, SourceEntity } from "../stage14/common";
import { sanitizePath, sanitizeTypeLabel, type SanitizeStats } from "./sanitize";

export interface TallyRow {
  field: string;
  observedType: string;
  canonicalType: string;
  count: number;
}

export interface CodeRow {
  field: string;
  code: string;
  count: number;
}

export interface NormalizationTally {
  changes: TallyRow[];
  warnings: CodeRow[];
  errors: CodeRow[];
  fieldQuarantines: CodeRow[];
  documents: Record<SourceEntity, { ok: number; rejected: number }>;
  redactedLabels: number;
}

type Normalizer = (raw: unknown, sourceId?: string) => NormalizationResult<unknown>;

const NORMALIZERS: Record<SourceEntity, Normalizer> = {
  users: normalizeUserDocument,
  courses: normalizeCourseDocument,
  schedules: normalizeScheduleDocument,
  bookingMock: normalizeBookingDocument,
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function rowsFrom(map: Map<string, number>, parts: number): TallyRow[] {
  return [...map.entries()]
    .map(([key, count]) => {
      const [field, observedType, canonicalType] = key.split("\t");
      return { field: field ?? "", observedType: observedType ?? "", canonicalType: canonicalType ?? "", count };
    })
    .filter((row) => row.field !== "" || parts === 0)
    .sort((a, b) => `${a.field}${a.observedType}${a.canonicalType}`.localeCompare(`${b.field}${b.observedType}${b.canonicalType}`));
}

function codeRows(map: Map<string, number>): CodeRow[] {
  return [...map.entries()]
    .map(([key, count]) => {
      const [field, code] = key.split("\t");
      return { field: field ?? "", code: code ?? "", count };
    })
    .sort((a, b) => `${a.field}${a.code}`.localeCompare(`${b.field}${b.code}`));
}

export function emptyTally(): {
  changes: Map<string, number>;
  warnings: Map<string, number>;
  errors: Map<string, number>;
  fieldQuarantines: Map<string, number>;
  documents: Record<SourceEntity, { ok: number; rejected: number }>;
  stats: SanitizeStats;
} {
  return {
    changes: new Map(),
    warnings: new Map(),
    errors: new Map(),
    fieldQuarantines: new Map(),
    documents: {
      users: { ok: 0, rejected: 0 },
      courses: { ok: 0, rejected: 0 },
      schedules: { ok: 0, rejected: 0 },
      bookingMock: { ok: 0, rejected: 0 },
    },
    stats: { redactedLabels: 0 },
  };
}

/** Counts the arrays the canonical normalizer actually returned.
 * A rejected document contributes errors only: `fail()` does not return the
 * changes collected before the first failing field. Repeated slot changes and
 * preserved map values therefore follow the normalizer, not a second converter. */
export function accumulateNormalization(
  entity: SourceEntity,
  raw: RawDoc,
  tally: ReturnType<typeof emptyTally>
): void {
  const result = NORMALIZERS[entity](raw, "redacted");
  if (!result.ok) {
    tally.documents[entity].rejected += 1;
    for (const error of result.errors) {
      bump(tally.errors, `${sanitizePath(error.field)}\t${error.code}`);
    }
    return;
  }
  tally.documents[entity].ok += 1;
  for (const change of result.changes) {
    const field = sanitizePath(change.field);
    const observedType = sanitizeTypeLabel(change.observedType, tally.stats);
    const canonicalType = sanitizeTypeLabel(change.canonicalType, tally.stats);
    bump(tally.changes, `${field}\t${observedType}\t${canonicalType}`);
  }
  for (const warning of result.warnings) {
    bump(tally.warnings, `${sanitizePath(warning.field)}\t${warning.code}`);
  }
  for (const item of result.quarantined) {
    bump(tally.fieldQuarantines, `${sanitizePath(item.field)}\t${item.observedType}`);
  }
}

export function finishTally(tally: ReturnType<typeof emptyTally>): NormalizationTally {
  return {
    changes: rowsFrom(tally.changes, 3),
    warnings: codeRows(tally.warnings),
    errors: codeRows(tally.errors),
    fieldQuarantines: codeRows(tally.fieldQuarantines),
    documents: tally.documents,
    redactedLabels: tally.stats.redactedLabels,
  };
}
