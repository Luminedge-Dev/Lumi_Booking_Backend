// Public Stage 17 evidence. Counts only. Identifiers and digests stay in the
// gitignored manifest files.

import type { ManifestDeltaReport } from "./manifest-delta";
import type { SourceIdentityReport } from "./source-manifest";
import { assertReportSafe } from "./sanitize";

export interface EvidenceInput {
  mode: "dry-run" | "classify" | "review";
  status?: "complete" | "blocked";
  source?: SourceIdentityReport;
  canonical?: ManifestDeltaReport;
  executionAuthority: "none";
  liveEvidence: "not-attested";
  countAgreement?: boolean;
  sqlPreviewPresent?: boolean;
  blockedReason?: string;
}

export function renderEvidence(input: EvidenceInput): string {
  const lines = [
    `status: ${input.status ?? "complete"}`,
    `mode: ${input.mode}`,
    "executionAuthority: none",
    "liveEvidence: not-attested",
    "canonicalRowsAbsent is not a confirmed MongoDB deletion.",
    "Count agreement is not point-in-time consistency.",
  ];
  if (input.blockedReason) lines.push(`blocked: ${input.blockedReason}`);
  if (input.countAgreement !== undefined) lines.push(`countAgreement: ${input.countAgreement}`);
  if (input.sqlPreviewPresent) lines.push("sqlPreview: present");
  if (input.source) {
    lines.push(
      `sourceAdded: ${input.source.sourceAdded}`,
      `sourceModified: ${input.source.sourceModified}`,
      `sourceDeleted: ${input.source.sourceDeleted}`,
      `sourceUnchanged: ${input.source.sourceUnchanged}`,
      `laterAccepted: ${input.source.laterAccepted}`,
      `laterRootQuarantined: ${input.source.laterRootQuarantined}`,
      `acceptedToQuarantined: ${input.source.acceptedToQuarantined}`,
      `quarantinedToAccepted: ${input.source.quarantinedToAccepted}`,
      `addedAndRootQuarantined: ${input.source.addedAndRootQuarantined}`,
      `modifiedAndRootQuarantined: ${input.source.modifiedAndRootQuarantined}`,
      input.source.interpretation
    );
  }
  if (input.canonical) {
    lines.push(
      "comparison: canonical-rows",
      `canonicalRowsAdded: ${input.canonical.canonicalRowsAdded}`,
      `canonicalRowsUpdated: ${input.canonical.canonicalRowsUpdated}`,
      `canonicalRowsAbsent: ${input.canonical.canonicalRowsAbsent}`,
      `canonicalRowsUnchanged: ${input.canonical.canonicalRowsUnchanged}`,
      input.canonical.interpretation
    );
  }
  const text = `${lines.join("\n")}\n`;
  assertReportSafe(text);
  return text;
}
