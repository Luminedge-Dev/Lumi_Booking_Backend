// Stage 14 -- run reports. PII-safe by construction: ids, counts, reason codes,
// field NAMES and opaque group keys only. No document values, no addresses,
// no connection strings.

import fs from "node:fs";
import path from "node:path";
import { TABLES, type SourceEntity } from "./common";
import type { PipelineResult } from "./pipeline";
import type { ReconciliationReport } from "./reconcile/reconcile";
import type { TableManifest } from "./validate/expectation";

export interface RunMeta {
  runId: string;
  mode: "dry-run" | "load" | "reconcile";
  startedAt: string;
  finishedAt: string;
  options: Record<string, unknown>;
}

export function quarantineByCode(pipeline: PipelineResult): Array<{ entity: SourceEntity; kind: string; code: string; entries: number; units: number }> {
  const map = new Map<string, { entity: SourceEntity; kind: string; code: string; entries: number; units: number }>();
  for (const q of pipeline.quarantine) {
    const key = `${q.entity}|${q.kind}|${q.code}`;
    const current = map.get(key) ?? { entity: q.entity, kind: q.kind, code: q.code, entries: 0, units: 0 };
    current.entries += 1;
    current.units += q.units;
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => `${a.entity}${a.kind}${a.code}`.localeCompare(`${b.entity}${b.kind}${b.code}`));
}

export function buildSummary(pipeline: PipelineResult, meta: RunMeta): Record<string, unknown> {
  const ledger = pipeline.ledger.snapshot();
  return {
    ...meta,
    pipelineMode: pipeline.mode,
    sampled: pipeline.sampled,
    resumed: pipeline.resumed,
    sourceCounts: pipeline.sourceCounts,
    ledger,
    quarantineByCode: quarantineByCode(pipeline),
    findings: pipeline.state.findings.toSorted(),
    undeclaredSourceFields: pipeline.state.undeclaredReport(),
    emailDuplicateGroups: {
      groups: pipeline.state.emailDuplicateGroups().length,
      documents: pipeline.state.emailDuplicateGroups().reduce((n, g) => n + g.memberIds.length, 0),
      detail: pipeline.state.emailDuplicateGroups(),
      disposition: "FLAGGED_AND_LOADED -- no merge, no unique index (Stage 14 does not decide email identity)",
    },
    fingerprints: pipeline.expectation.fingerprints(),
    unbalancedKinds: pipeline.ledger.unbalanced().map((u) => u.kind),
  };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeRunArtifacts(dir: string, pipeline: PipelineResult, meta: RunMeta, reconciliation?: ReconciliationReport): void {
  writeJson(path.join(dir, "summary.json"), buildSummary(pipeline, meta));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "quarantine.jsonl"), pipeline.quarantine.map((q) => JSON.stringify(q)).join("\n") + (pipeline.quarantine.length ? "\n" : ""), "utf8");
  writeJson(path.join(dir, "manifest.json"), pipeline.expectation.toManifest());
  if (reconciliation) writeJson(path.join(dir, "reconciliation.json"), reconciliation);
}

export function readManifest(file: string): TableManifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as TableManifest;
}

export function formatLedgerTable(pipeline: PipelineResult): string {
  const ledger = pipeline.ledger.snapshot();
  const lines = ["table                   source  accepted  quarantined  (parent)  skipped  committed"];
  for (const table of TABLES) {
    const l = ledger[table];
    lines.push(
      `${table.padEnd(22)} ${String(l.source).padStart(7)} ${String(l.accepted).padStart(9)} ${String(l.quarantined).padStart(12)} ${String(l.parentQuarantined).padStart(9)} ${String(l.skipped).padStart(8)} ${String(l.committed).padStart(10)}`
    );
  }
  return lines.join("\n");
}

export function formatReconciliation(report: ReconciliationReport): string {
  const lines = [`verdict: ${report.verdict}`];
  lines.push("table                  expected   target  missing  unexpected  mismatch  drift  unexplained");
  for (const t of report.tables) {
    const c = t.comparison;
    lines.push(
      `${t.table.padEnd(22)} ${String(c.expected).padStart(8)} ${String(c.target).padStart(8)} ${String(c.missingInTarget).padStart(8)} ${String(c.unexpectedInTarget).padStart(11)} ${String(c.digestMismatch).padStart(9)} ${String(c.explainedDrift).padStart(6)} ${String(c.unexplained).padStart(12)}`
    );
  }
  for (const b of report.blockers) lines.push(`BLOCKER: ${b}`);
  return lines.join("\n");
}
