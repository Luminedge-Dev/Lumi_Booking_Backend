// Stage 14 -- ETL command-line configuration. The single place the ETL reads
// the environment. Values are used, never printed.

import { config as loadDotenv } from "dotenv";
import { parseToken, type CursorToken } from "./extract/source";
import { SOURCE_ENTITIES, type SourceEntity } from "./common";
import type { ResumePoint } from "./pipeline";

export type Mode = "dry-run" | "load" | "reconcile";

export interface RunConfig {
  mode: Mode;
  batchSize: number;
  userBatchSize: number;
  limit?: number;
  resumeFrom?: ResumePoint;
  /** Required for load/reconcile: the literal acknowledgement of the write target. */
  targetAck?: string;
  outDir: string;
  runId: string;
  manifestPath?: string;
  mongoUri: string;
  env: { NEON_DB_URL?: string | undefined; NEON_DIRECT_URL?: string | undefined };
}

function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInt(text: string | undefined, fallback: number, flag: string): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export function parseResumeFrom(text: string): ResumePoint {
  const idx = text.indexOf(":");
  const entityText = idx < 0 ? text : text.slice(0, idx);
  if (!(SOURCE_ENTITIES as readonly string[]).includes(entityText)) {
    throw new Error(`--resume-from entity must be one of ${SOURCE_ENTITIES.join(", ")}`);
  }
  const token: CursorToken | undefined = idx < 0 ? undefined : parseToken(text.slice(idx + 1));
  return { entity: entityText as SourceEntity, token };
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): RunConfig {
  const [modeText, ...rest] = argv;
  if (modeText !== "dry-run" && modeText !== "load" && modeText !== "reconcile") {
    throw new Error("usage: runner <dry-run|load|reconcile> [--batch-size N] [--user-batch-size N] [--limit N] [--resume-from entity[:bracket:last]] [--target stage13-dev] [--manifest file] [--out-dir dir]");
  }
  const mode: Mode = modeText;
  const limitText = takeValue(rest, "--limit");
  const limit = limitText === undefined ? undefined : positiveInt(limitText, 1, "--limit");
  if (limit !== undefined && mode !== "dry-run") throw new Error("--limit (sample mode) is only allowed with dry-run");
  const resumeText = takeValue(rest, "--resume-from");
  if (resumeText !== undefined && mode !== "load") throw new Error("--resume-from is only meaningful with load");

  const runId = takeValue(rest, "--run-id") ?? `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("--run-id may contain only letters, digits, '.', '_' and '-'");

  const mongoUri = env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGODB_URI is required (source, read-only)");

  return {
    mode,
    batchSize: positiveInt(takeValue(rest, "--batch-size"), 500, "--batch-size"),
    userBatchSize: positiveInt(takeValue(rest, "--user-batch-size"), 100, "--user-batch-size"),
    limit,
    resumeFrom: resumeText ? parseResumeFrom(resumeText) : undefined,
    targetAck: takeValue(rest, "--target"),
    outDir: takeValue(rest, "--out-dir") ?? "_migration/stage14",
    runId,
    manifestPath: takeValue(rest, "--manifest"),
    mongoUri,
    env: { NEON_DB_URL: env.NEON_DB_URL, NEON_DIRECT_URL: env.NEON_DIRECT_URL },
  };
}

export function loadConfig(argv: string[]): RunConfig {
  loadDotenv({ quiet: true });
  return parseArgs(argv, process.env);
}
