import fs from "node:fs";
import path from "node:path";
import type { QuarantineEntry, SourceEntity, TableName } from "../stage14/common";
import { TABLES } from "../stage14/common";
import type { ReadOnlySource } from "../stage14/extract/source";
import { formatLedgerTable } from "../stage14/report";
import { runPipeline, type PipelineResult } from "../stage14/pipeline";
import { EXPECTED_COUNTS, SNAPSHOT_DB } from "./privilege";
import { openVerifiedSnapshot } from "./local-source";
import { accumulateNormalization, emptyTally, finishTally, type NormalizationTally } from "./normalization-tally";
import { assertReportSafe, sanitizePath } from "./sanitize";

const REPORT_PATH = path.resolve(__dirname, "../../../../context/evidence/stage17-local-canonical-dry-run.md");
const CODE_DIRS = [
  path.resolve(__dirname, "../stage14/transform"),
  path.resolve(__dirname, "../../../tools/migration"),
];

export interface CodeCount {
  entity: string;
  kind: string;
  code: string;
  field: string;
  scope: string;
  entries: number;
  units: number;
}

export function knownQuarantineCodes(): Set<string> {
  const codes = new Set<string>();
  for (const dir of CODE_DIRS) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of text.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) codes.add(match[1]!);
    }
  }
  return codes;
}

export function aggregateQuarantine(entries: QuarantineEntry[], vocabulary: Set<string>): { rows: CodeCount[]; unknown: string[] } {
  const map = new Map<string, CodeCount>();
  const unknown = new Set<string>();
  for (const entry of entries) {
    if (!vocabulary.has(entry.code)) unknown.add(entry.code);
    const field = sanitizePath(entry.field ?? "");
    const scope = sanitizePath(entry.scope);
    const key = `${entry.entity}|${entry.kind}|${entry.code}|${field}|${scope}`;
    const current = map.get(key) ?? { entity: entry.entity, kind: entry.kind, code: entry.code, field, scope, entries: 0, units: 0 };
    current.entries += 1;
    current.units += entry.units;
    map.set(key, current);
  }
  return {
    rows: [...map.values()].sort((a, b) => `${a.entity}${a.kind}${a.code}${a.field}${a.scope}`.localeCompare(`${b.entity}${b.kind}${b.code}${b.field}${b.scope}`)),
    unknown: [...unknown].sort(),
  };
}

async function tallySource(source: ReadOnlySource): Promise<NormalizationTally> {
  const tally = emptyTally();
  for (const entity of Object.keys(EXPECTED_COUNTS) as SourceEntity[]) {
    for await (const batch of source.collection(entity).readBatches({ batchSize: 200 })) {
      for (const doc of batch.docs) accumulateNormalization(entity, doc, tally);
    }
  }
  return finishTally(tally);
}

function countCode(rows: CodeCount[], code: string, fieldIncludes?: string): number {
  return rows.filter((row) => row.code === code && (fieldIncludes === undefined || row.field.includes(fieldIncludes))).reduce((sum, row) => sum + row.entries, 0);
}

function changeCount(tally: NormalizationTally, field: string, observedType: string, canonicalType: string): number {
  return tally.changes.find((row) => row.field === field && row.observedType === observedType && row.canonicalType === canonicalType)?.count ?? 0;
}

function errorCount(tally: NormalizationTally, field: string, code: string): number {
  return tally.errors.find((row) => row.field === field && row.code === code)?.count ?? 0;
}

function render(pipeline: PipelineResult, tally: NormalizationTally, quarantine: CodeCount[], unknown: string[], blockers: string[], identityActions: string[]): string {
  const ledger = pipeline.ledger.snapshot();
  const lines: string[] = [];
  lines.push("# Stage 17 local canonical dry run");
  lines.push("");
  lines.push(`**Verdict:** ${blockers.length === 0 ? "LOCAL CANONICAL DRY RUN PASS" : "BLOCKED"}`);
  lines.push("**B7:** OPEN. This run does not prove live Atlas freshness or cutover readiness.");
  lines.push("**PostgreSQL:** not opened. `committed` is 0 because `runPipeline` was called without a sink.");
  lines.push("");
  lines.push("## Security");
  lines.push("");
  lines.push(`**VERIFIED.** Authenticated as \`reader\` on authentication database \`admin\`. Host \`127.0.0.1\`, port \`27017\`. Dataset \`${SNAPSHOT_DB}\`.`);
  lines.push("");
  lines.push(`Effective actions: ${identityActions.join(", ")}.`);
  lines.push("");
  lines.push("The application MongoDB URI was not read. Atlas, Neon, and PostgreSQL were not contacted. No MongoDB write was issued.");
  lines.push("");
  lines.push("## Source counts");
  lines.push("");
  lines.push("| Collection | Before | Extracted | After |");
  lines.push("| --- | --- | --- | --- |");
  for (const entity of Object.keys(EXPECTED_COUNTS) as SourceEntity[]) {
    const counts = pipeline.sourceCounts[entity];
    lines.push(`| ${entity} | ${counts.before} | ${counts.extracted} | ${counts.after} |`);
  }
  lines.push("");
  lines.push("## Ledger");
  lines.push("");
  lines.push("Stage 14 defines `source = accepted + quarantined + skipped`. `skipped` is initialized to 0 and no Stage 14 path increments it. `committed` increments only inside `noteCommitted`, which runs only when a sink is present.");
  lines.push("");
  lines.push("```text");
  lines.push(formatLedgerTable(pipeline));
  lines.push("```");
  lines.push("");
  lines.push("| Table | skipped | committed |");
  lines.push("| --- | --- | --- |");
  for (const table of TABLES) {
    const line = ledger[table as TableName];
    lines.push(`| ${table} | ${line.skipped} | ${line.committed} |`);
  }
  lines.push("");
  lines.push("## Quarantine by reason");
  lines.push("");
  lines.push("Counts are pipeline entries. Scope keys are replaced with `<id>`. Historical per-code totals from the Stage 14 dry run are not in this checkout, so a higher count of a known code is a source-count difference, not a reconstructed historical delta.");
  lines.push("");
  lines.push("| Entity | Kind | Code | Field | Scope | Entries | Units |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of quarantine) {
    lines.push(`| ${row.entity} | ${row.kind} | ${row.code} | ${row.field || ""} | ${row.scope} | ${row.entries} | ${row.units} |`);
  }
  lines.push("");
  lines.push(`Unknown codes: ${unknown.length === 0 ? "none" : unknown.join(", ")}.`);
  lines.push("");
  lines.push("## Normalization");
  lines.push("");
  lines.push("The tally calls `normalizeUserDocument`, `normalizeCourseDocument`, `normalizeScheduleDocument`, and `normalizeBookingDocument`. Rejected documents contribute their error list only, because a failed result does not return partial changes. Preserved maps do not emit one change per key.");
  lines.push("");
  lines.push("| Entity | Normalizer accepted | Normalizer rejected |");
  lines.push("| --- | --- | --- |");
  for (const entity of Object.keys(EXPECTED_COUNTS) as SourceEntity[]) {
    const doc = tally.documents[entity];
    lines.push(`| ${entity} | ${doc.ok} | ${doc.rejected} |`);
  }
  lines.push("");
  lines.push("### Changes");
  lines.push("");
  lines.push("| Field | Observed type | Canonical type | Count |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of tally.changes) lines.push(`| ${row.field} | ${row.observedType} | ${row.canonicalType} | ${row.count} |`);
  lines.push("");
  lines.push("### Warnings");
  lines.push("");
  if (tally.warnings.length === 0) lines.push("None.");
  else {
    lines.push("| Field | Code | Count |");
    lines.push("| --- | --- | --- |");
    for (const row of tally.warnings) lines.push(`| ${row.field} | ${row.code} | ${row.count} |`);
  }
  lines.push("");
  lines.push("### Normalizer errors");
  lines.push("");
  lines.push("| Field | Code | Count |");
  lines.push("| --- | --- | --- |");
  for (const row of tally.errors) lines.push(`| ${row.field} | ${row.code} | ${row.count} |`);
  lines.push("");
  lines.push("### Field quarantines on accepted documents");
  lines.push("");
  if (tally.fieldQuarantines.length === 0) lines.push("None.");
  else {
    lines.push("| Field | Observed type | Count |");
    lines.push("| --- | --- | --- |");
    for (const row of tally.fieldQuarantines) lines.push(`| ${row.field} | ${row.code} | ${row.count} |`);
  }
  lines.push("");
  lines.push(`Redacted type labels: ${tally.redactedLabels}.`);
  lines.push("");
  lines.push("## Known findings");
  lines.push("");
  lines.push(`String \`totalSlot\` changes (string to number): ${changeCount(tally, "schedules.timeSlots[].totalSlot", "string", "number")}.`);
  lines.push(`Pipeline \`USER_NOT_FOUND_IN_SOURCE\` entries: ${countCode(quarantine, "USER_NOT_FOUND_IN_SOURCE")}.`);
  lines.push(`Normalizer missing \`bookingMock.location\`: ${errorCount(tally, "bookingMock.location", "MISSING_REQUIRED_FIELD")}.`);
  lines.push(`Pipeline first-error \`MISSING_REQUIRED_FIELD\` on \`bookingMock.location\`: ${countCode(quarantine, "MISSING_REQUIRED_FIELD", "bookingMock.location")}.`);
  lines.push("Seat drift is not a quarantine code. Accepted slot rows keep source \`seatsLeft\` and \`capacityTotal\`.");
  lines.push("Teacher columns and \`teachersBySchedule\` stay separate. No assignment row is created for a missing map key, and the one known mismatch is not repaired.");
  lines.push("`users.mock`, `users.totalMock`, and `mocks[]` stay independent.");
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  const findings = pipeline.state.findings.toSorted();
  if (findings.length === 0) lines.push("None.");
  else {
    lines.push("| Code | Scope | Count |");
    lines.push("| --- | --- | --- |");
    for (const finding of findings) lines.push(`| ${finding.code} | ${sanitizePath(finding.scope)} | ${finding.count} |`);
  }
  lines.push("");
  lines.push("## Undeclared fields");
  lines.push("");
  const undeclared = pipeline.state.undeclaredReport();
  if (undeclared.length === 0) lines.push("None.");
  else {
    lines.push("| Scope | Field | Count |");
    lines.push("| --- | --- | --- |");
    for (const row of undeclared) lines.push(`| ${sanitizePath(row.scope)} | ${sanitizePath(row.field)} | ${row.count} |`);
  }
  lines.push("");
  const emailGroups = pipeline.state.emailDuplicateGroups();
  lines.push(`Case-variant email groups: ${emailGroups.length} groups, ${emailGroups.reduce((sum, group) => sum + group.memberIds.length, 0)} documents. Group keys and member ids are omitted. Disposition remains flagged and loaded, unmerged.`);
  lines.push("");
  lines.push("## Comparison with D-037");
  lines.push("");
  lines.push("| Collection | D-037 source | This snapshot | Difference |");
  lines.push("| --- | --- | --- | --- |");
  lines.push("| users | 9,046 | 9,205 | +159 |");
  lines.push("| courses | 5 | 5 | 0 |");
  lines.push("| schedules | 2,383 | 2,457 | +74 |");
  lines.push("| bookingMock | 20,889 | 21,210 | +321 |");
  lines.push("");
  lines.push("D-037 accepted 9,042 users, 2,380 schedules, and 19,755 bookings, with 1,142 quarantine entries. This checkout has no per-code record of that run. Headline count differences are source growth. They are not a normalization-rule change and they do not prove which documents were inserted, updated, or deleted.");
  lines.push("");
  lines.push("## Information loss");
  lines.push("");
  lines.push("- The pipeline keeps the first normalizer error on a rejected root. Later errors on that document appear in the normalizer tally and not as extra pipeline entries.");
  lines.push("- Child rows of a quarantined root are parent-quarantined units.");
  lines.push("- Undeclared fields are counted and omitted from accepted rows.");
  lines.push("- Preserved schedule maps are copied without per-key normalization.");
  lines.push("- The in-memory expectation digests were built and not written. The manifest is an id-to-digest map.");
  lines.push("- The extract is a live keyset read. Before, extracted, and after counts are the stability check this reader can make.");
  lines.push("");
  lines.push("## Unsupported");
  lines.push("");
  lines.push("Per-code comparison with the original Stage 14 dry run. Point-in-time Atlas consistency. PostgreSQL reconciliation.");
  lines.push("");
  if (blockers.length > 0) {
    lines.push("## Review blockers");
    lines.push("");
    for (const blocker of blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function executeLocalDryRun(uri = process.env.STAGE17_LOCAL_MONGODB_URI): Promise<{ verdict: "PASS" | "BLOCKED"; reportPath: string }> {
  if (!uri) throw new Error("STAGE17_LOCAL_MONGODB_URI is required");
  const { source, identity } = await openVerifiedSnapshot(uri);
  try {
    for (const entity of Object.keys(EXPECTED_COUNTS) as SourceEntity[]) {
      const count = await source.collection(entity).count();
      if (count !== EXPECTED_COUNTS[entity]) throw new Error(`source count gate failed for ${entity}`);
    }
    const pipeline = await runPipeline({
      source,
      batchSize: 500,
      userBatchSize: 100,
      log: (message) => {
        process.stdout.write(`[stage17-local] ${message}\n`);
      },
    });
    const tally = await tallySource(source);
    const vocabulary = knownQuarantineCodes();
    const aggregated = aggregateQuarantine(pipeline.quarantine, vocabulary);
    const ledger = pipeline.ledger.snapshot();
    const blockers: string[] = [];
    if (pipeline.mode !== "dry-run") blockers.push("pipeline mode was not dry-run");
    for (const table of TABLES) {
      if (ledger[table].committed !== 0) blockers.push(`${table} committed is not 0`);
      if (ledger[table].skipped !== 0) blockers.push(`${table} skipped is not 0`);
      if (ledger[table].source !== ledger[table].accepted + ledger[table].quarantined + ledger[table].skipped) {
        blockers.push(`${table} ledger equation failed`);
      }
    }
    for (const entity of Object.keys(EXPECTED_COUNTS) as SourceEntity[]) {
      const counts = pipeline.sourceCounts[entity];
      if (counts.before !== EXPECTED_COUNTS[entity] || counts.before !== counts.extracted || counts.extracted !== counts.after) {
        blockers.push(`${entity} counts were not stable`);
      }
    }
    if (aggregated.unknown.length > 0) blockers.push(`unknown quarantine codes: ${aggregated.unknown.join(", ")}`);
    const stringCapacities = changeCount(tally, "schedules.timeSlots[].totalSlot", "string", "number");
    if (stringCapacities !== 964) blockers.push(`string totalSlot changes were ${stringCapacities}, expected 964`);
    const capacityShape = aggregated.rows.filter((row) => row.field.includes("totalSlot") && (row.code === "INVALID_NUMBER_SHAPE" || row.code === "NON_INTEGER_NUMBER"));
    if (capacityShape.length > 0) blockers.push("a totalSlot value failed integer normalization");
    if (tally.redactedLabels !== 0) blockers.push("a normalization label was outside the closed alias list");
    const missingLocation = errorCount(tally, "bookingMock.location", "MISSING_REQUIRED_FIELD");
    if (missingLocation !== 1115) blockers.push(`missing-location normalizer errors were ${missingLocation}, expected 1115`);
    const missingUsers = countCode(aggregated.rows, "USER_NOT_FOUND_IN_SOURCE");
    if (missingUsers !== 2) blockers.push(`USER_NOT_FOUND_IN_SOURCE entries were ${missingUsers}, expected 2`);
    if (aggregated.rows.some((row) => /SEAT|DRIFT|CAPACITY_REPAIR/.test(row.code))) blockers.push("a seat-drift repair code was emitted");
    const report = render(pipeline, tally, aggregated.rows, aggregated.unknown, blockers, identity.actions);
    assertReportSafe(report);
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, report, "utf8");
    return { verdict: blockers.length === 0 ? "PASS" : "BLOCKED", reportPath: REPORT_PATH };
  } finally {
    await source.close();
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  executeLocalDryRun()
    .then((result) => {
      process.stdout.write(`[stage17-local] verdict=${result.verdict}\n`);
      process.exitCode = result.verdict === "PASS" ? 0 : 2;
    })
    .catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "Error";
      process.stderr.write(`[stage17-local] stopped: ${name}\n`);
      process.exitCode = 2;
    });
}
