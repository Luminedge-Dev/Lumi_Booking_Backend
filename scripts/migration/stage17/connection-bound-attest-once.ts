// One-shot Stage 17 connection-bound attestation entry.
// Importing this file does not call Neon, open Prisma, or read application database configuration.
// A passing report does not approve apiAttestation and does not authorize a later operation.

import { AttestationStopError } from "./attestation";
import { executeConnectionBoundAttestation, type ConnectionBoundAttestation, type OpenAttestorPrisma } from "./connection-bound-attestor";
import type { NeonApiFetch } from "./neon-api-transport";
import { PreflightTimeoutError } from "./readonly-preflight-adapter";

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  deps: { fetchImpl?: NeonApiFetch; openPrisma?: OpenAttestorPrisma; clock?: () => string } = {},
): Promise<number> {
  if (argv.length !== 2) {
    process.stderr.write("STOP: unexpected arguments\n");
    return 1;
  }
  const token = env.STAGE17_NEON_API_TOKEN ?? "";
  const pooledUrl = env.STAGE17_PREFLIGHT_POOLED_URL ?? "";
  const directUrl = env.STAGE17_PREFLIGHT_DIRECT_URL ?? "";
  if (token === "" || pooledUrl === "" || directUrl === "") {
    process.stderr.write("STOP: an attestation input is absent\n");
    return 1;
  }
  try {
    const report = await executeConnectionBoundAttestation({
      pooledUrl,
      directUrl,
      token,
      fetchImpl: deps.fetchImpl,
      openPrisma: deps.openPrisma,
      clock: deps.clock,
    });
    if (containsCredential(report.report, [token, pooledUrl, directUrl])) {
      process.stderr.write("STOP: attestation report contains a credential\n");
      return 1;
    }
    process.stdout.write(report.report);
    return report.connectionBoundChecks === "passed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${redactMessage(error)}\n`);
    return 1;
  }
}

function containsCredential(report: string, secrets: readonly string[]): boolean {
  if (/postgres(ql)?:\/\//i.test(report) || /Bearer /.test(report)) return true;
  return secrets.some((secret) => secret !== "" && report.includes(secret));
}

function redactMessage(error: unknown): string {
  if (error instanceof PreflightTimeoutError) return "STOP: PostgreSQL query timed out";
  const message = error instanceof Error ? error.message : "";
  if (message === "" || /postgres(ql)?:\/\//i.test(message) || /:[^:@/\s]+@/.test(message) || message.includes("Bearer ")) {
    return "STOP: PostgreSQL driver failed";
  }
  if (error instanceof AttestationStopError || message.startsWith("STOP:")) return message;
  return "STOP: PostgreSQL driver failed";
}

export type { ConnectionBoundAttestation };
