// Stage 14 -- write-target guard.
//
// Any PostgreSQL write (load) or read (reconcile) must first obtain a
// VerifiedTarget. It can only be produced by verifyStage13Target(), which pins
// the Neon compute endpoint of branch stage13-dev (the same pin Stage 13's own
// live test uses) and refuses anything that looks like production.
//
// The TypeScript unique symbol is not the authorization check. verifyStage13Target
// is the only function that adds an object to the runtime brand set. A cast or a
// copied property bag is not a verified target. This module does not mint a
// Stage 17 rehearsal capability.
//
// Error messages never include a connection string.

import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";

/** Neon compute endpoint of branch stage13-dev (context/progress-tracker.md, D-036). */
export const STAGE13_DEV_ENDPOINT_ID = "ep-rapid-bread-b4gi8ftb";
/** Fragment of the production endpoint id that must never be targeted. */
const PRODUCTION_ENDPOINT_FRAGMENT = "falling-brook";

export class StopError extends Error {
  constructor(message: string) {
    super(`STOP: ${message}`);
    this.name = "StopError";
  }
}

declare const verifiedBrand: unique symbol;

export interface VerifiedTarget {
  readonly [verifiedBrand]: true;
  readonly branch: "stage13-dev";
  readonly endpointId: string;
}

const stage13Brands = new WeakSet<object>();

export function isVerifiedStage13Target(value: unknown): value is VerifiedTarget {
  return typeof value === "object" && value !== null && stage13Brands.has(value);
}

export interface TargetEnv {
  NEON_DB_URL?: string | undefined;
  NEON_DIRECT_URL?: string | undefined;
}

export function verifyStage13Target(env: TargetEnv): VerifiedTarget {
  const runtimeUrl = env.NEON_DB_URL;
  const directUrl = env.NEON_DIRECT_URL;
  if (!runtimeUrl || !directUrl) {
    throw new StopError("NEON_DB_URL and NEON_DIRECT_URL are both required; a target is never guessed.");
  }
  let runtime;
  let direct;
  try {
    runtime = classifyDatabaseUrl(runtimeUrl);
    direct = classifyDatabaseUrl(directUrl);
  } catch {
    throw new StopError("a Neon URL is malformed.");
  }
  if (runtime.provider !== "neon" || direct.provider !== "neon") throw new StopError("targets must be Neon PostgreSQL endpoints.");
  if (!runtime.pooled || direct.pooled) throw new StopError("NEON_DB_URL must be the pooled endpoint and NEON_DIRECT_URL the direct endpoint.");
  if (runtime.database !== "neondb" || direct.database !== "neondb") throw new StopError("database name is not the Stage 13 database.");
  const runtimeId = normalizedEndpointId(runtimeUrl);
  const directId = normalizedEndpointId(directUrl);
  if (runtimeId.includes(PRODUCTION_ENDPOINT_FRAGMENT) || directId.includes(PRODUCTION_ENDPOINT_FRAGMENT)) {
    throw new StopError("a production endpoint was detected.");
  }
  if (runtimeId !== directId || runtimeId !== STAGE13_DEV_ENDPOINT_ID) {
    throw new StopError("endpoint pair is not the approved stage13-dev compute.");
  }
  const target = Object.freeze({ branch: "stage13-dev" as const, endpointId: runtimeId });
  stage13Brands.add(target);
  return target as unknown as VerifiedTarget;
}
