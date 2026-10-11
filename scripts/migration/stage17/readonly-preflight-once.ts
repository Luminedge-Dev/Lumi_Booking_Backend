// One-shot Stage 17 read-only preflight entry.
// Importing this file does not connect and does not read application database configuration.
// A passing report does not approve apiAttestation and does not grant a write.

import { executeReadOnlyPreflight } from "./readonly-preflight-adapter";
import { PreflightStopError, assertReadOnlyChildUrls, type PreflightReport } from "./readonly-preflight";
import { createPgReadOnlyClientFactory } from "./readonly-pg-client";
import { createReadOnlyRuntimeConnector, type ReadOnlyClientFactory } from "./readonly-runtime-connector";

export async function executeReadOnlyPreflightOnce(input: {
  pooledUrl: string;
  directUrl: string;
  readOnlyRole: string;
  openClient: ReadOnlyClientFactory;
}): Promise<PreflightReport> {
  if (input.pooledUrl === "" || input.directUrl === "" || input.readOnlyRole === "") {
    throw new PreflightStopError("a preflight input is absent");
  }
  assertReadOnlyChildUrls(input.pooledUrl, input.directUrl);
  if (roleFromUrl(input.pooledUrl) !== input.readOnlyRole || roleFromUrl(input.directUrl) !== input.readOnlyRole) {
    throw new PreflightStopError("PostgreSQL role is not the dedicated read-only role");
  }
  return executeReadOnlyPreflight({
    pooledUrl: input.pooledUrl,
    directUrl: input.directUrl,
    connect: createReadOnlyRuntimeConnector({
      pooledUrl: input.pooledUrl,
      directUrl: input.directUrl,
      readOnlyRole: input.readOnlyRole,
      openClient: input.openClient,
    }),
  });
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  openClient?: ReadOnlyClientFactory,
): Promise<number> {
  if (argv.length !== 2) {
    process.stderr.write("STOP: unexpected arguments\n");
    return 1;
  }
  const pooledUrl = env.STAGE17_PREFLIGHT_POOLED_URL ?? "";
  const directUrl = env.STAGE17_PREFLIGHT_DIRECT_URL ?? "";
  const readOnlyRole = env.STAGE17_PREFLIGHT_ROLE ?? "";
  if (pooledUrl === "" || directUrl === "" || readOnlyRole === "") {
    process.stderr.write("STOP: a preflight input is absent\n");
    return 1;
  }
  try {
    const report = await executeReadOnlyPreflightOnce({
      pooledUrl,
      directUrl,
      readOnlyRole,
      openClient: openClient ?? createPgReadOnlyClientFactory({ expectedRole: readOnlyRole }),
    });
    if (report.report.includes(pooledUrl) || report.report.includes(directUrl) || /postgres(ql)?:\/\//i.test(report.report)) {
      process.stderr.write("STOP: preflight report contains a credential\n");
      return 1;
    }
    process.stdout.write(report.report);
    return 0;
  } catch (error) {
    process.stderr.write(`${redactMessage(error)}\n`);
    return 1;
  }
}

function roleFromUrl(raw: string): string {
  try {
    return decodeURIComponent(new URL(raw).username);
  } catch {
    throw new PreflightStopError("a Neon URL is malformed");
  }
}

function redactMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "" || /postgres(ql)?:\/\//i.test(message) || /:[^:@/\s]+@/.test(message)) {
    return "STOP: PostgreSQL driver failed";
  }
  return message.startsWith("STOP:") ? message : "STOP: PostgreSQL driver failed";
}
