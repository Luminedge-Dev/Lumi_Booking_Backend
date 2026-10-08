import { config as loadDotenv } from "dotenv";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../../src/app/database/neon-target";

loadDotenv();

export const STAGE13_ENDPOINT_ID = "ep-rapid-bread-b4gi8ftb";

// Stage 15 PostgreSQL tests may only ever run against the approved
// non-production stage13-dev compute. Same pinning as the Stage 13 foundation
// proof: anything else stops the run before a single query is issued.
export function assertStage13Target(): void {
  const runtimeUrl = process.env.NEON_DB_URL;
  const directUrl = process.env.NEON_DIRECT_URL;
  if (!runtimeUrl || !directUrl) {
    throw new Error("STOP: NEON_DB_URL and NEON_DIRECT_URL are both required. Do not invent a URL.");
  }
  const runtime = classifyDatabaseUrl(runtimeUrl);
  const direct = classifyDatabaseUrl(directUrl);
  if (runtime.provider !== "neon" || direct.provider !== "neon") {
    throw new Error("STOP: Stage 15 URLs must be Neon PostgreSQL endpoints.");
  }
  if (!runtime.pooled || direct.pooled) {
    throw new Error("STOP: NEON_DB_URL must be pooled and NEON_DIRECT_URL must be direct.");
  }
  if (runtime.database !== "neondb" || direct.database !== "neondb") {
    throw new Error("STOP: database name is not neondb.");
  }
  const runtimeId = normalizedEndpointId(runtimeUrl);
  const directId = normalizedEndpointId(directUrl);
  if (runtimeId !== directId || runtimeId !== STAGE13_ENDPOINT_ID) {
    throw new Error("STOP: endpoint pair is not the approved stage13-dev compute.");
  }
  if (runtimeId.includes("falling-brook") || directId.includes("falling-brook")) {
    throw new Error("STOP: production endpoint detected.");
  }
}

// Every row a Stage 15 test creates carries this prefix in its id (or a
// derived natural key) so cleanup can never touch Stage 14 reconciled data.
export const TEST_PREFIX = "stage15-test-";
