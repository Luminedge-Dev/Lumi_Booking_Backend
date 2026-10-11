/** PII-safe labels for Stage 17 reports. Map keys and enum spellings that are
 * not on the closed alias list are removed before anything is written. */

const HEX_ID = /[0-9a-fA-F]{24}/g;
const EMAIL = /[^\s@]+@[^\s@]+/g;

/** Closed alias tokens already emitted by the Stage 14 normalizers as
 * `string:<token>`. Anything else is redacted. */
const ENUM_ALIAS_TOKENS = new Set(["present", "Present", "Absent", "pending", "completed", "missed", "Computer-Based", "ComputerBased", "Paper-Based"]);

export interface SanitizeStats {
  redactedLabels: number;
}

export function sanitizePath(value: string): string {
  return value.replace(HEX_ID, "<id>").replace(EMAIL, "<redacted>");
}

export function sanitizeTypeLabel(label: string, stats: SanitizeStats): string {
  const split = label.indexOf(":");
  if (split < 0) return label;
  const prefix = label.slice(0, split);
  const suffix = label.slice(split + 1);
  if (ENUM_ALIAS_TOKENS.has(suffix)) return label;
  stats.redactedLabels += 1;
  return `${prefix}:<redacted>`;
}

export function assertReportSafe(text: string): void {
  if (/mongodb(\+srv)?:\/\//i.test(text)) throw new Error("report contains a connection URI");
  if (/[0-9a-fA-F]{24}/.test(text)) throw new Error("report contains a 24-hex identifier");
  if (/[^\s@]+@[^\s@]+/.test(text)) throw new Error("report contains an email address");
}
