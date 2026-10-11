// Stage 17 F1 command parsing. No environment file is loaded and no database
// client is constructed.

import { SourceManifestError } from "./source-manifest";

export type F1Mode = "dry-run" | "classify" | "review";
export type SourcePolicyFlag = "LOCAL_SNAPSHOT" | "FUTURE_FRESH_SOURCE";

export interface Stage17Command {
  mode: F1Mode;
  runId?: string;
  policy: SourcePolicyFlag;
  earlierRunId?: string;
  laterRunId?: string;
  acknowledgement?: string;
}

const MODES = new Set<F1Mode>(["dry-run", "classify", "review"]);

function take(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new SourceManifestError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

export function parseStage17Args(argv: string[]): Stage17Command {
  const args = [...argv];
  const mode = args.shift();
  if (mode === undefined || !MODES.has(mode as F1Mode)) throw new SourceManifestError("mode must be dry-run, classify, or review");
  const runId = take(args, "--run-id");
  const policyText = take(args, "--policy") ?? "LOCAL_SNAPSHOT";
  const earlierRunId = take(args, "--earlier");
  const laterRunId = take(args, "--later");
  const acknowledgement = take(args, "--ack");
  if (args.length > 0) throw new SourceManifestError("unexpected argument");
  if (policyText !== "LOCAL_SNAPSHOT" && policyText !== "FUTURE_FRESH_SOURCE") throw new SourceManifestError("policy is not recognized");
  if (mode === "dry-run" && !runId) throw new SourceManifestError("dry-run requires --run-id");
  if (mode === "classify" && (!earlierRunId || !laterRunId)) throw new SourceManifestError("classify requires --earlier and --later");
  if (mode === "review" && acknowledgement !== "stage17-rehearsal") throw new SourceManifestError("review acknowledgement is not stage17-rehearsal");
  return { mode: mode as F1Mode, runId, policy: policyText, earlierRunId, laterRunId, acknowledgement };
}
