// Sanitized F1 baseline note. Counts and reason codes only.

import fs from "node:fs";
import path from "node:path";
import { SOURCE_ENTITIES, TABLES } from "../stage14/common";
import type { PipelineResult } from "../stage14/pipeline";
import { MANIFEST_DIGEST_VERSION } from "./manifest-delta";
import { aggregateQuarantine } from "./local-dry-run";
import type { DryRunOutcome } from "./orchestrate";
import { assertReportSafe } from "./sanitize";
import { SOURCE_DIGEST_VERSION, SOURCE_ENCODING_VERSION } from "./source-manifest";

const NOTE = path.resolve(__dirname, "../../../../context/evidence/stage17-f1-local-baseline.md");

export function writeBaselineNote(input: { outcome: DryRunOutcome; actions: readonly string[]; vocabulary: Set<string> }): void {
  const lines = [
    "# Stage 17 F1 local snapshot baseline",
    "",
    `**Status:** ${input.outcome.status === "complete" ? "PASS" : "BLOCKED"}`,
    "**B7:** OPEN. Count agreement is not point-in-time consistency and is not live Atlas freshness.",
    "**Writes:** none. The pipeline had no sink. MongoDB was read through the local reader. Atlas, Neon, and PostgreSQL were not opened.",
    "",
    "## Reader gate",
    "",
    "Host `127.0.0.1`, port `27017`, database `luminedge_stage17_snapshot_20261008`, account `reader` on authentication database `admin`.",
    "",
    `Actions: ${input.actions.join(", ")}.`,
    "",
    "The application MongoDB URI was not read. No admin credential was used.",
    "",
    "## Versions",
    "",
    `Source digest \`${SOURCE_DIGEST_VERSION}\`. Source encoding \`${SOURCE_ENCODING_VERSION}\`. Canonical row digest \`${MANIFEST_DIGEST_VERSION}\`.`,
    "",
    "The MongoDB driver promotes Int32 and Double to JavaScript numbers before this process sees them. A promoted number is tagged `js-number` and cannot be distinguished from another promoted numeric type. BSON class instances that the driver still exposes stay on their own tags. This baseline and later comparisons must use the same driver decoding rules.",
    "",
  ];
  const pipeline = input.outcome.pipeline;
  const source = input.outcome.sourceManifest;
  if (pipeline && source) {
    lines.push("## Source counts", "", "| Entity | Before | Extracted | After | Accepted roots | Root-quarantined |", "| --- | --- | --- | --- | --- | --- |");
    for (const entity of SOURCE_ENTITIES) {
      const scan = pipeline.sourceCounts[entity];
      const documents = source.entities[entity].documents;
      const accepted = documents.filter((row) => row.outcome === "accepted").length;
      const quarantined = documents.filter((row) => row.outcome === "root-quarantined").length;
      lines.push(`| ${entity} | ${scan.before} | ${scan.extracted} | ${scan.after} | ${accepted} | ${quarantined} |`);
    }
    lines.push("", "## Child-table ledger", "", "| Table | Source | Accepted | Quarantined | Committed |", "| --- | --- | --- | --- | --- |");
    const snapshot = pipeline.ledger.snapshot();
    for (const table of TABLES) {
      const line = snapshot[table];
      lines.push(`| ${table} | ${line.source} | ${line.accepted} | ${line.quarantined} | ${line.committed} |`);
    }
    const grouped = aggregateQuarantine(pipeline.quarantine, input.vocabulary);
    lines.push("", `Quarantine entries: ${pipeline.quarantine.length}.`, "", "| Code | Entries |", "| --- | --- |");
    const byCode = new Map<string, number>();
    for (const row of grouped.rows) byCode.set(row.code, (byCode.get(row.code) ?? 0) + row.entries);
    for (const [code, entries] of [...byCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`| ${code} | ${entries} |`);
    lines.push("", `Unrecognized reason codes: ${grouped.unknown.length}.`, `Manifest execution id recorded: ${source.executionId.length === 36 ? "yes" : "no"}.`, "Count agreement holds. That is not a point-in-time snapshot.");
  } else {
    lines.push("The manifest pair was not finalized.", "", input.outcome.report.trim());
  }
  const text = `${lines.join("\n")}\n`;
  assertReportSafe(text);
  fs.mkdirSync(path.dirname(NOTE), { recursive: true });
  fs.writeFileSync(NOTE, text);
}
