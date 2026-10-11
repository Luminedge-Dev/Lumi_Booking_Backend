// Stage 17 F1 orchestration. Dry-run observes the Stage 14 pipeline and writes
// one gitignored manifest pair. It never constructs a sink or a database client.
// Executable extraction is locked to an injected LOCAL_SNAPSHOT source.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { SOURCE_ENTITIES } from "../stage14/common";
import type { ReadOnlySource } from "../stage14/extract/source";
import { runPipeline, type PipelineResult } from "../stage14/pipeline";
import { assessCleanup, type ForeignKeyReferencer, type IdentityCensus } from "./allowlist";
import type { Stage17Command } from "./cli";
import { renderEvidence } from "./evidence";
import { classifyManifestDelta, parseDigestManifest, stampExpectationManifest, type DigestManifest } from "./manifest-delta";
import { verifyRehearsalTarget, type RehearsalGuardInput } from "./rehearsal-guard";
import {
  assertManifestRoot,
  compareSourceManifests,
  countsAgree,
  SourceEncodingError,
  createSourceRecorder,
  finalizeManifestPair,
  inventoryMatches,
  manifestPath,
  readSourceManifest,
  type SourceIdentityManifest,
  type SourceIdentityReport,
} from "./source-manifest";

export interface DryRunRequest {
  command: Stage17Command;
  source: ReadOnlySource;
  manifestRoot: string;
  /** Offline tests only. Real runs must use the approved manifest directory. */
  allowTestRoot?: boolean;
  batchSize?: number;
  userBatchSize?: number;
  limitPerEntity?: number;
  /** When set, the future local snapshot inventory is required. Fixtures leave this unset. */
  checkSnapshotInventory?: boolean;
  /** Comparison with the earlier canonical dry run. Fixtures leave this unset. */
  expectedQuarantineEntries?: number;
  /** When set, a reason code outside this set blocks finalization. */
  knownQuarantineCodes?: ReadonlySet<string>;
}

export interface DryRunOutcome {
  status: "complete" | "blocked";
  report: string;
  pipeline: PipelineResult | null;
  sourceManifest: SourceIdentityManifest | null;
  canonicalManifest: DigestManifest | null;
}

export function executeDryRun(request: DryRunRequest): Promise<DryRunOutcome> {
  if (request.command.mode !== "dry-run") throw new Error("dry-run mode is required");
  if (request.command.policy !== "LOCAL_SNAPSHOT") throw new Error("F1 extraction is locked to LOCAL_SNAPSHOT");
  if (!request.command.runId) throw new Error("dry-run requires a run id");
  return runDryRun(request);
}

function blocked(reason: string): DryRunOutcome {
  return {
    status: "blocked",
    pipeline: null,
    sourceManifest: null,
    canonicalManifest: null,
    report: renderEvidence({
      mode: "dry-run",
      status: "blocked",
      blockedReason: reason,
      executionAuthority: "none",
      liveEvidence: "not-attested",
      countAgreement: false,
    }),
  };
}

async function runDryRun(request: DryRunRequest): Promise<DryRunOutcome> {
  const recorder = createSourceRecorder();
  let pipeline: PipelineResult;
  try {
    pipeline = await runPipeline({
      source: request.source,
      batchSize: request.batchSize ?? 50,
      userBatchSize: request.userBatchSize ?? 50,
      limitPerEntity: request.limitPerEntity,
      onSourceDocument: ({ raw }) => recorder.capture(raw),
      onDocument: ({ entity, result }) => recorder.finish(entity, result),
    });
  } catch (error) {
    if (error instanceof SourceEncodingError) return blocked(error.message);
    return blocked("pipeline did not finish");
  }
  if (pipeline.mode !== "dry-run") return blocked("pipeline was not a dry-run");
  if (Object.values(pipeline.ledger.snapshot()).some((line) => line.committed !== 0)) return blocked("a sink commit was recorded");
  if (!countsAgree(pipeline.sourceCounts)) return blocked("count agreement failed");
  if (request.checkSnapshotInventory && !inventoryMatches(pipeline.sourceCounts)) return blocked("source inventory does not match the local snapshot");
  if (request.expectedQuarantineEntries !== undefined && pipeline.quarantine.length !== request.expectedQuarantineEntries) {
    return blocked("quarantine total differs from the canonical dry-run baseline");
  }
  if (request.knownQuarantineCodes && pipeline.quarantine.some((entry) => !request.knownQuarantineCodes!.has(entry.code))) {
    return blocked("quarantine contains an unrecognized reason code");
  }
  let sourceManifest: SourceIdentityManifest;
  try {
    sourceManifest = recorder.build(pipeline.sourceCounts);
  } catch {
    return blocked("source identity is not unique");
  }
  if (!SOURCE_ENTITIES.every((entity) => sourceManifest.entities[entity].documents.length === pipeline.sourceCounts[entity].extracted)) {
    return blocked("source manifest does not cover every extracted root");
  }
  const canonicalManifest = stampExpectationManifest(pipeline.expectation.toManifest());
  const executionId = randomUUID();
  const stamped = { ...sourceManifest, executionId };
  try {
    finalizeManifestPair({
      root: request.manifestRoot,
      runId: request.command.runId!,
      allowTestRoot: request.allowTestRoot === true,
      executionId,
      source: stamped,
      canonical: canonicalManifest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "run id already exists" || message === "manifest directory is a symlink" || message === "manifest root is not the approved directory" || message === "run id is not safe") {
      throw error;
    }
    return blocked("manifest pair was not finalized");
  }
  return {
    status: "complete",
    pipeline,
    sourceManifest: stamped,
    canonicalManifest,
    report: renderEvidence({
      mode: "dry-run",
      status: "complete",
      executionAuthority: "none",
      liveEvidence: "not-attested",
      countAgreement: true,
    }),
  };
}

export function executeClassify(
  root: string,
  earlierRunId: string,
  laterRunId: string,
  allowTestRoot = false
): { source: SourceIdentityReport; canonical: ReturnType<typeof classifyManifestDelta>; report: string } {
  const earlier = readManifestPair(root, earlierRunId, allowTestRoot);
  const later = readManifestPair(root, laterRunId, allowTestRoot);
  const source = compareSourceManifests(earlier.source, later.source);
  const canonical = classifyManifestDelta(earlier.canonical, later.canonical);
  const report = renderEvidence({
    mode: "classify",
    source,
    canonical,
    executionAuthority: "none",
    liveEvidence: "not-attested",
    countAgreement: source.countAgreement,
  });
  return { source, canonical, report };
}

export function readManifestPair(root: string, runId: string, allowTestRoot: boolean): { executionId: string; source: SourceIdentityManifest; canonical: DigestManifest } {
  assertManifestRoot(root, allowTestRoot);
  const sourceFile = manifestPath(root, runId, "source-identity.json");
  const canonicalFile = manifestPath(root, runId, "canonical-rows.json");
  if (!fs.existsSync(sourceFile) || !fs.existsSync(canonicalFile)) throw new Error("manifest pair is incomplete");
  const source = readSourceManifest(sourceFile);
  const canonical = readCanonical(canonicalFile, source.executionId);
  return { executionId: source.executionId, source, canonical };
}

export interface ReviewRequest {
  guard: RehearsalGuardInput;
  referencers: readonly ForeignKeyReferencer[];
  identity: IdentityCensus;
}

export function executeReview(request: ReviewRequest): { executionAuthority: "none"; liveEvidence: "not-attested"; statementPreview: string; report: string } {
  const facts = verifyRehearsalTarget(request.guard);
  const assessment = assessCleanup({ facts, referencers: request.referencers, identity: request.identity });
  const report = renderEvidence({
    mode: "review",
    executionAuthority: assessment.executionAuthority,
    liveEvidence: assessment.liveEvidence,
    sqlPreviewPresent: true,
  });
  return { executionAuthority: "none", liveEvidence: "not-attested", statementPreview: assessment.statementPreview, report };
}

function readCanonical(file: string, expectedExecutionId: string): DigestManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("canonical manifest schema is incomplete");
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { executionId?: unknown }).executionId !== expectedExecutionId) {
    throw new Error("manifest pair is not from one execution");
  }
  return parseDigestManifest(parsed);
}
