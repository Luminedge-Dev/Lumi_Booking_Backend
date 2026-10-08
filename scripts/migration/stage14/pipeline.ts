// Stage 14 -- the ETL pipeline.
//
//   read-only Mongo -> keyset batches -> Stage 10.5 normalizers -> relational
//   transform -> validation/quarantine -> (optional) PostgreSQL sink
//
// The pipeline never opens a database itself: it receives a ReadOnlySource and,
// in load mode only, a RowSink. Dry-run therefore cannot write by construction.

import {
  canonicalHexId,
  SOURCE_ENTITIES,
  type AggregateResult,
  type QuarantineEntry,
  type RawDoc,
  type SourceEntity,
  type TableRows,
  TABLES,
} from "./common";
import { formatToken, type CursorToken, type ReadOnlySource } from "./extract/source";
import type { RowSink } from "./load/sink";
import { PipelineState } from "./state";
import { transformBooking } from "./transform/bookings";
import { transformCourse } from "./transform/courses";
import { transformSchedule } from "./transform/schedules";
import { transformUser } from "./transform/users";
import { ExpectationCollector } from "./validate/expectation";
import { Ledger, LedgerImbalanceError } from "./validate/ledger";

export interface ResumePoint {
  entity: SourceEntity;
  token?: CursorToken;
}

export interface PipelineOptions {
  source: ReadOnlySource;
  /** Absent => dry-run: nothing is ever written. */
  sink?: RowSink;
  batchSize: number;
  userBatchSize: number;
  /** Smoke-test mode: stop each entity after N documents (cross-entity cascades are then expected noise). */
  limitPerEntity?: number;
  /** Entities BEFORE this one are transformed for lookup state only (never committed). */
  resumeFrom?: ResumePoint;
  log?: (message: string) => void;
  /** Called after every committed (or dry-run-validated) batch. */
  onCheckpoint?: (info: { entity: SourceEntity; token: CursorToken; docs: number }) => void;
}

export interface SourceCounts {
  before: number;
  extracted: number;
  after: number;
}

export interface PipelineResult {
  ledger: Ledger;
  quarantine: QuarantineEntry[];
  state: PipelineState;
  expectation: ExpectationCollector;
  sourceCounts: Record<SourceEntity, SourceCounts>;
  mode: "dry-run" | "load";
  sampled: boolean;
  resumed: boolean;
}

type Transformer = (raw: RawDoc, state: PipelineState) => AggregateResult;

const TRANSFORMERS: Record<SourceEntity, Transformer> = {
  users: transformUser,
  courses: transformCourse,
  schedules: transformSchedule,
  bookingMock: transformBooking,
};

// Dependency order (no database FKs exist; the order guarantees a parent is
// decided before any document that references it is validated).
const ENTITY_ORDER: readonly SourceEntity[] = ["users", "courses", "schedules", "bookingMock"];

function mergeRows(into: TableRows, from: TableRows | undefined): void {
  if (!from) return;
  for (const table of TABLES) {
    const rows = from[table];
    if (rows && rows.length > 0) (into[table] ??= []).push(...rows);
  }
}

const BRACKET_RANK = { string: 0, objectId: 1, other: 2 } as const;

function idBracket(id: unknown): keyof typeof BRACKET_RANK {
  if (typeof id === "string") return "string";
  return canonicalHexId(id) !== undefined && typeof id !== "string" ? "objectId" : "other";
}

/** True when `id` sorts strictly after the resume token (BSON bracket order, then value). */
export function isAfterToken(id: unknown, token: CursorToken): boolean {
  const bracket = idBracket(id);
  if (bracket !== token.bracket) return BRACKET_RANK[bracket] > BRACKET_RANK[token.bracket];
  if (bracket === "other") return false;
  const text = bracket === "objectId" ? (canonicalHexId(id) ?? "") : String(id);
  return text > token.last;
}

async function scanIds(source: ReadOnlySource, entity: SourceEntity, batchSize: number): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const batch of source.collection(entity).readBatches({ batchSize, projection: { _id: 1 } })) {
    for (const doc of batch.docs) {
      const hex = canonicalHexId(doc._id);
      if (hex) ids.add(hex);
    }
  }
  return ids;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const log = options.log ?? (() => undefined);
  const { source } = options;
  const state = new PipelineState();
  state.sampleMode = options.limitPerEntity !== undefined && options.sink === undefined;
  const ledger = new Ledger();
  const expectation = new ExpectationCollector();
  const quarantine: QuarantineEntry[] = [];

  const sourceCounts = {} as Record<SourceEntity, SourceCounts>;
  for (const entity of SOURCE_ENTITIES) {
    sourceCounts[entity] = { before: await source.collection(entity).count(), extracted: 0, after: 0 };
  }

  // Existence index (IDs only, bounded). Drives *BySchedule key resolution and
  // makes "exists in source" checks correct even for smoke-test samples.
  for (const entity of SOURCE_ENTITIES) {
    for (const id of await scanIds(source, entity, options.batchSize)) state.sourceIds[entity].add(id);
  }
  state.keyIndex = { bookings: state.sourceIds.bookingMock, schedules: state.sourceIds.schedules };
  log(
    `existence index ready: ${state.sourceIds.users.size} users, ${state.sourceIds.courses.size} courses, ` +
      `${state.sourceIds.schedules.size} schedules, ${state.sourceIds.bookingMock.size} bookings`
  );

  const resumeIndex = options.resumeFrom ? ENTITY_ORDER.indexOf(options.resumeFrom.entity) : -1;

  for (const [index, entity] of ENTITY_ORDER.entries()) {
    const indexOnly = options.sink !== undefined && index < resumeIndex;
    const resumeAfter = options.resumeFrom?.entity === entity ? options.resumeFrom.token : undefined;
    const batchSize = entity === "users" ? options.userBatchSize : options.batchSize;
    const transform = TRANSFORMERS[entity];
    let docsSeen = 0;
    log(`entity ${entity}: ${indexOnly ? "index-only (before resume point)" : options.sink ? "load" : "dry-run"}${resumeAfter ? ` resume after ${formatToken(resumeAfter)}` : ""}`);

    // Documents at or before the resume token are ALWAYS re-read and re-transformed so the
    // parent lookups (accepted users / schedule slots / ids) are complete, but they are
    // never committed again: only documents after the token are written.
    batches: for await (const batch of source.collection(entity).readBatches({ batchSize })) {
      const rows: TableRows = {};
      const rootIds: string[] = [];
      let docsInBatch = 0;
      for (const raw of batch.docs) {
        if (options.limitPerEntity !== undefined && docsSeen >= options.limitPerEntity) break;
        docsSeen += 1;
        docsInBatch += 1;
        const result = transform(raw, state);
        quarantine.push(...ledger.record(result));
        for (const finding of result.findings) state.findings.add(finding.code, finding.scope, finding.count);
        if (resumeAfter && !isAfterToken(raw._id, resumeAfter)) continue;
        mergeRows(rows, result.rows);
        const hex = canonicalHexId(raw._id);
        if (hex) rootIds.push(hex);
      }
      sourceCounts[entity].extracted += docsInBatch;

      expectation.add(rows);
      if (options.sink && !indexOnly && (rootIds.length > 0 || docsInBatch === 0)) {
        await options.sink.commit({ entity, rootIds, rows, token: batch.token });
        ledger.noteCommitted(rows);
      }
      options.onCheckpoint?.({ entity, token: batch.token, docs: docsInBatch });
      if (options.limitPerEntity !== undefined && docsSeen >= options.limitPerEntity) break batches;
    }
    log(`entity ${entity}: ${sourceCounts[entity].extracted} documents processed`);
  }

  for (const entity of SOURCE_ENTITIES) {
    sourceCounts[entity].after = await source.collection(entity).count();
  }

  const unbalanced = ledger.unbalanced();
  if (unbalanced.length > 0) {
    throw new LedgerImbalanceError("<run>", unbalanced.map((u) => u.kind).join(","), "source != accepted + quarantined + skipped");
  }

  return {
    ledger,
    quarantine,
    state,
    expectation,
    sourceCounts,
    mode: options.sink ? "load" : "dry-run",
    sampled: options.limitPerEntity !== undefined,
    resumed: options.resumeFrom !== undefined,
  };
}
