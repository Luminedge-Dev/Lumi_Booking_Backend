// Stage 17 F1 runner. dry-run, classify, and review only.
// A live dry-run opens the local reader only when connectLocal is set.

import type { ReadOnlySource } from "../stage14/extract/source";
import { writeBaselineNote } from "./baseline-note";
import { parseStage17Args } from "./cli";
import { knownQuarantineCodes } from "./local-dry-run";
import { openVerifiedSnapshot } from "./local-source";
import { executeClassify, executeDryRun, executeReview, type ReviewRequest } from "./orchestrate";
import { defaultManifestRoot } from "./source-manifest";

/** Headline quarantine-entry count from the earlier local canonical dry run. */
const CANONICAL_DRY_RUN_QUARANTINE_ENTRIES = 1142;

export { defaultManifestRoot };

export interface Stage17Runtime {
  source?: ReadOnlySource;
  manifestRoot?: string;
  review?: ReviewRequest;
  stdout?: (text: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
  /** Live local snapshot open. Unit tests leave this unset. */
  connectLocal?: boolean;
}

export async function runStage17(argv: string[], runtime: Stage17Runtime = {}): Promise<number> {
  const command = parseStage17Args(argv);
  const write = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  if (command.mode === "dry-run") {
    if (command.policy !== "LOCAL_SNAPSHOT") throw new Error("F1 extraction is locked to LOCAL_SNAPSHOT");
    if (runtime.manifestRoot && runtime.manifestRoot !== defaultManifestRoot()) throw new Error("manifest root is not the approved directory");
    if (runtime.source) {
      const outcome = await executeDryRun({ command, source: runtime.source, manifestRoot: defaultManifestRoot(), allowTestRoot: false });
      write(outcome.report);
      return outcome.status === "complete" ? 0 : 2;
    }
    if (runtime.connectLocal !== true) throw new Error("local snapshot extraction is not authorized");
    const uri = runtime.env?.STAGE17_LOCAL_MONGODB_URI;
    if (!uri) throw new Error("STAGE17_LOCAL_MONGODB_URI is required");
    const opened = await openVerifiedSnapshot(uri);
    try {
      const vocabulary = knownQuarantineCodes();
      const outcome = await executeDryRun({
        command,
        source: opened.source,
        manifestRoot: defaultManifestRoot(),
        checkSnapshotInventory: true,
        expectedQuarantineEntries: CANONICAL_DRY_RUN_QUARANTINE_ENTRIES,
        knownQuarantineCodes: vocabulary,
        batchSize: 500,
        userBatchSize: 100,
      });
      writeBaselineNote({ outcome, actions: opened.identity.actions, vocabulary });
      write(outcome.report);
      return outcome.status === "complete" ? 0 : 2;
    } finally {
      await opened.source.close();
    }
  }
  if (command.mode === "classify") {
    const outcome = executeClassify(runtime.manifestRoot ?? defaultManifestRoot(), command.earlierRunId!, command.laterRunId!);
    write(outcome.report);
    return 0;
  }
  if (!runtime.review) throw new Error("review input is not authorized");
  const outcome = executeReview(runtime.review);
  write(outcome.report);
  return outcome.executionAuthority === "none" ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runStage17(argv, { connectLocal: true, env: process.env });
}
