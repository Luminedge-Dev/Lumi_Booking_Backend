// Stage 14 -- reconciliation: SOURCE (freshly re-derived, read-only) vs TARGET.
//
// Verdict is PASS only when EVERY of these holds:
//   1. source snapshot was stable during the run (count before == extracted == after);
//   2. the ledger balances for every kind (source = accepted + quarantined + skipped);
//   3. per table: zero unexplained difference between expected and actual
//      (ID sets, content digests); drift is "explained" only by a prior manifest;
//   4. every hard SQL target check is zero (orphans, duplicate keys, Better Auth rows);
//   5. every teacher-assignment parent that is absent from the target is a
//      source row that was quarantined (never an unexplained loss).

import { TABLES, type SourceEntity, type TableName } from "../common";
import type { PipelineResult } from "../pipeline";
import type { VerifiedTarget } from "../guards";
import { ledgerEquation, compareTable, type TableComparison } from "./compare";
import type { LedgerLine } from "../validate/ledger";
import type { TableManifest } from "../validate/expectation";
import type { PrismaClient } from "../../../../src/generated/prisma/client.js";
import { danglingTeacherParents, readAllTableDigests, runTargetChecks, type TargetCheck } from "./target-reader";

export interface TableReport {
  table: TableName;
  ledger: LedgerLine & { delta: number };
  comparison: Omit<TableComparison, "missingInTarget" | "unexpectedInTarget" | "digestMismatch"> & {
    missingInTarget: number;
    unexpectedInTarget: number;
    digestMismatch: number;
    /** First few offending primary keys, for triage (ids are not PII). */
    sampleOffenders: string[];
  };
}

export interface ReconciliationReport {
  verdict: "PASS" | "BLOCKED";
  blockers: string[];
  sourceSnapshot: Record<SourceEntity, { before: number; extracted: number; after: number; stable: boolean }>;
  tables: TableReport[];
  targetChecks: TargetCheck[];
  teacherParents: {
    bookingIdsNotLoaded: number;
    scheduleIdsNotLoaded: number;
    explainedByQuarantine: number;
    unexplained: number;
  };
}

export async function reconcile(params: {
  pipeline: PipelineResult;
  prisma: PrismaClient;
  target: VerifiedTarget;
  previousManifest?: TableManifest;
}): Promise<ReconciliationReport> {
  const { pipeline, prisma, target, previousManifest } = params;
  const blockers: string[] = [];

  if (pipeline.sampled) blockers.push("pipeline ran in sample mode (--limit); reconciliation requires a full extraction");
  if (pipeline.resumed) blockers.push("pipeline ran from a resume point; reconciliation requires a full extraction");

  const sourceSnapshot = {} as ReconciliationReport["sourceSnapshot"];
  for (const [entity, c] of Object.entries(pipeline.sourceCounts) as Array<[SourceEntity, { before: number; extracted: number; after: number }]>) {
    const stable = c.before === c.extracted && c.extracted === c.after;
    sourceSnapshot[entity] = { ...c, stable };
    if (!stable) blockers.push(`source ${entity} changed during extraction (before ${c.before}, extracted ${c.extracted}, after ${c.after}); rerun`);
  }

  const actual = await readAllTableDigests(prisma, target);
  const tables: TableReport[] = [];
  const ledger = pipeline.ledger.snapshot();
  for (const table of TABLES) {
    const comparison = compareTable(pipeline.expectation.entries(table), actual[table], previousManifest?.[table]);
    const eq = ledgerEquation(ledger[table]);
    if (!eq.balanced) blockers.push(`ledger for ${table} is unbalanced by ${eq.delta}`);
    if (comparison.unexplained > 0) blockers.push(`${table}: ${comparison.unexplained} unexplained difference(s) between expected and target`);
    if (ledger[table].accepted !== comparison.expected) {
      blockers.push(`${table}: ledger accepted (${ledger[table].accepted}) != expectation size (${comparison.expected})`);
    }
    tables.push({
      table,
      ledger: { ...ledger[table], delta: eq.delta },
      comparison: {
        expected: comparison.expected,
        target: comparison.target,
        explainedDrift: comparison.explainedDrift,
        unexplained: comparison.unexplained,
        missingInTarget: comparison.missingInTarget.length,
        unexpectedInTarget: comparison.unexpectedInTarget.length,
        digestMismatch: comparison.digestMismatch.length,
        sampleOffenders: [...comparison.missingInTarget, ...comparison.unexpectedInTarget, ...comparison.digestMismatch].slice(0, 10),
      },
    });
  }

  const targetChecks = await runTargetChecks(prisma, target);
  for (const check of targetChecks) {
    if (check.severity === "hard" && check.count !== 0) blockers.push(`target check ${check.id}: ${check.count}`);
  }

  // Teacher-assignment parents absent from the target must be quarantined source rows.
  const dangling = await danglingTeacherParents(prisma, target);
  const quarantinedBookings = new Set(pipeline.quarantine.filter((q) => q.entity === "bookingMock" && q.scope === "root").map((q) => q.sourceId));
  const quarantinedSchedules = new Set(pipeline.quarantine.filter((q) => q.entity === "schedules" && q.scope === "root").map((q) => q.sourceId));
  const explained =
    dangling.bookingIds.filter((id) => quarantinedBookings.has(id)).length + dangling.scheduleIds.filter((id) => quarantinedSchedules.has(id)).length;
  const total = dangling.bookingIds.length + dangling.scheduleIds.length;
  if (total - explained > 0) blockers.push(`teacher_assignments reference ${total - explained} parent id(s) that are neither loaded nor quarantined`);

  return {
    verdict: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers,
    sourceSnapshot,
    tables,
    targetChecks,
    teacherParents: {
      bookingIdsNotLoaded: dangling.bookingIds.length,
      scheduleIdsNotLoaded: dangling.scheduleIds.length,
      explainedByQuarantine: explained,
      unexplained: total - explained,
    },
  };
}
