// Stage 14 -- ETL runner (CLI).
//
//   dry-run    extract + transform + validate. NO PostgreSQL connection is ever made.
//   load       write to the verified Neon branch stage13-dev ONLY (needs --target stage13-dev).
//   reconcile  re-derive the expected state from the source and compare to stage13-dev (SELECT only).
//
// MongoDB is only ever READ (extract/source.ts exposes no write API).
// Connection strings are never printed.

import path from "node:path";
import fs from "node:fs";
import { loadConfig, type RunConfig } from "./config";
import { connectReadOnlySource } from "./extract/source";
import { StopError, verifyStage13Target, type VerifiedTarget } from "./guards";
import { runPipeline, type PipelineResult } from "./pipeline";
import { formatLedgerTable, formatReconciliation, readManifest, writeJson, writeRunArtifacts, type RunMeta } from "./report";

function log(message: string): void {
  process.stdout.write(`[stage14] ${message}\n`);
}

function meta(config: RunConfig, startedAt: string): RunMeta {
  return {
    runId: config.runId,
    mode: config.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: {
      batchSize: config.batchSize,
      userBatchSize: config.userBatchSize,
      limit: config.limit ?? null,
      resumeFrom: config.resumeFrom ? { entity: config.resumeFrom.entity, hasToken: Boolean(config.resumeFrom.token) } : null,
    },
  };
}

function requireTarget(config: RunConfig): VerifiedTarget {
  if (config.targetAck !== "stage13-dev") {
    throw new StopError(`${config.mode} requires the explicit acknowledgement "--target stage13-dev".`);
  }
  return verifyStage13Target(config.env);
}

async function openTarget(target: VerifiedTarget) {
  // Dynamic import: dry-run must never even load the Prisma client.
  const { getPrismaClient, checkPostgresHealth, disconnectPrisma } = await import("../../../src/app/database/prisma.js");
  const prisma = getPrismaClient();
  await checkPostgresHealth(prisma);
  const rows = (await prisma.$queryRawUnsafe("SELECT current_database()::text AS db")) as Array<{ db: string }>;
  if (rows[0]?.db !== "neondb") throw new StopError("connected database is not the expected Stage 13 database.");
  return { prisma, target, disconnect: disconnectPrisma };
}

async function runDryRun(config: RunConfig, outDir: string): Promise<number> {
  const startedAt = new Date().toISOString();
  const source = await connectReadOnlySource(config.mongoUri);
  try {
    const pipeline = await runPipeline({ source, batchSize: config.batchSize, userBatchSize: config.userBatchSize, limitPerEntity: config.limit, log });
    writeRunArtifacts(outDir, pipeline, meta(config, startedAt));
    printPipeline(pipeline);
    return 0;
  } finally {
    await source.close();
  }
}

async function runLoad(config: RunConfig, outDir: string): Promise<number> {
  const target = requireTarget(config);
  const startedAt = new Date().toISOString();
  const source = await connectReadOnlySource(config.mongoUri);
  let opened: Awaited<ReturnType<typeof openTarget>> | undefined;
  try {
    opened = await openTarget(target);
    const { createPrismaSink } = await import("./load/loader.js");
    const sink = createPrismaSink(opened.prisma, target);
    const pipeline = await runPipeline({
      source,
      sink,
      batchSize: config.batchSize,
      userBatchSize: config.userBatchSize,
      resumeFrom: config.resumeFrom,
      log,
      onCheckpoint: ({ entity, token, docs }) => {
        writeJson(path.join(outDir, "checkpoint.json"), { runId: config.runId, entity, resumeToken: `${entity}:${token.bracket}:${token.last}`, docsInLastBatch: docs, at: new Date().toISOString() });
      },
    });
    const mismatches: string[] = pipeline.ledger
      .unbalanced()
      .map((u): string => u.kind)
      .concat(
        Object.entries(pipeline.ledger.snapshot())
          .filter(([, l]) => !pipeline.resumed && l.committed !== l.accepted)
          .map(([kind]) => `${kind}:committed!=accepted`)
      );
    writeRunArtifacts(outDir, pipeline, meta(config, startedAt));
    if (!pipeline.resumed && mismatches.length === 0) {
      writeJson(path.join(config.outDir, "latest-load-manifest.json"), pipeline.expectation.toManifest());
    }
    printPipeline(pipeline);
    if (mismatches.length > 0) {
      log(`LOAD BLOCKED: ${mismatches.join(", ")}`);
      return 2;
    }
    log("load committed; run `reconcile` next.");
    return 0;
  } finally {
    await opened?.disconnect();
    await source.close();
  }
}

async function runReconcile(config: RunConfig, outDir: string): Promise<number> {
  const target = requireTarget(config);
  const startedAt = new Date().toISOString();
  const source = await connectReadOnlySource(config.mongoUri);
  let opened: Awaited<ReturnType<typeof openTarget>> | undefined;
  try {
    opened = await openTarget(target);
    const { reconcile } = await import("./reconcile/reconcile.js");
    const pipeline = await runPipeline({ source, batchSize: config.batchSize, userBatchSize: config.userBatchSize, log });
    const manifestPath = config.manifestPath ?? path.join(config.outDir, "latest-load-manifest.json");
    const previousManifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : undefined;
    log(previousManifest ? "previous load manifest found (drift attribution enabled)" : "no previous load manifest (any difference is unexplained)");
    const report = await reconcile({ pipeline, prisma: opened.prisma, target, previousManifest });
    writeRunArtifacts(outDir, pipeline, meta(config, startedAt), report);
    printPipeline(pipeline);
    log(`\n${formatReconciliation(report)}`);
    return report.verdict === "PASS" ? 0 : 2;
  } finally {
    await opened?.disconnect();
    await source.close();
  }
}

function printPipeline(pipeline: PipelineResult): void {
  log(`mode=${pipeline.mode} sampled=${pipeline.sampled} resumed=${pipeline.resumed}`);
  for (const [entity, c] of Object.entries(pipeline.sourceCounts)) {
    log(`source ${entity}: before=${c.before} extracted=${c.extracted} after=${c.after}`);
  }
  log(`\n${formatLedgerTable(pipeline)}`);
  const groups = pipeline.state.emailDuplicateGroups();
  log(`case-insensitive duplicate email groups: ${groups.length} (${groups.reduce((n, g) => n + g.memberIds.length, 0)} documents)`);
  log(`quarantine entries: ${pipeline.quarantine.length}`);
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2));
  const outDir = path.join(config.outDir, config.runId);
  log(`mode=${config.mode} runId=${config.runId} batch=${config.batchSize}/${config.userBatchSize}${config.limit ? ` limit=${config.limit}` : ""}`);
  if (config.mode === "dry-run") return runDryRun(config, outDir);
  if (config.mode === "load") return runLoad(config, outDir);
  return runReconcile(config, outDir);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Never echo error objects wholesale: driver errors can embed connection details.
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof StopError ? error.message : error instanceof Error ? error.message.replace(/(mongodb(\+srv)?|postgres(ql)?):\/\/[^\s'"]+/gi, "<redacted-uri>") : "unknown error";
    process.stderr.write(`[stage14] FAILED (${name}): ${message}\n`);
    process.exitCode = 1;
  }
);
