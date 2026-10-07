import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config as loadDotenv } from "dotenv";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../src/app/database/neon-target";
import { checkPostgresHealth, disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { runSerializableTransaction } from "../../src/app/database/transaction";

loadDotenv();

const STAGE13_PROBE_ID = "stage13-probe-course";
const STAGE13_ENDPOINT_ID = "ep-rapid-bread-b4gi8ftb";

function assertStage13Pair(): void {
  const runtimeUrl = process.env.NEON_DB_URL;
  const directUrl = process.env.NEON_DIRECT_URL;
  if (!runtimeUrl || !directUrl) {
    throw new Error("STOP: NEON_DB_URL and NEON_DIRECT_URL are both required. Do not invent a URL.");
  }
  const runtime = classifyDatabaseUrl(runtimeUrl);
  const direct = classifyDatabaseUrl(directUrl);
  if (runtime.provider !== "neon" || direct.provider !== "neon") {
    throw new Error("STOP: Stage 13 URLs must be Neon PostgreSQL endpoints.");
  }
  if (!runtime.pooled || direct.pooled) {
    throw new Error("STOP: NEON_DB_URL must be pooled and NEON_DIRECT_URL must be direct.");
  }
  if (runtime.database !== "neondb" || direct.database !== "neondb") {
    throw new Error("STOP: Stage 13 database name is not neondb.");
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

describe("Stage 13 PostgreSQL foundation (live Neon)", () => {
  it("proves health, commit, rollback, and Serializable isolation on stage13-dev", async () => {
    assertStage13Pair();
    const prisma = getPrismaClient();
    try {
      await checkPostgresHealth(prisma);
      await prisma.course.deleteMany({ where: { id: STAGE13_PROBE_ID } });

      await prisma.$transaction(async (tx) => {
        await tx.course.create({
          data: { id: STAGE13_PROBE_ID, name: "Stage 13 probe", image: "probe" },
        });
        const row = await tx.course.findUnique({ where: { id: STAGE13_PROBE_ID } });
        assert.equal(row?.name, "Stage 13 probe");
      });
      await prisma.course.delete({ where: { id: STAGE13_PROBE_ID } });
      assert.equal(await prisma.course.findUnique({ where: { id: STAGE13_PROBE_ID } }), null);

      await assert.rejects(
        () =>
          prisma.$transaction(async (tx) => {
            await tx.course.create({
              data: { id: STAGE13_PROBE_ID, name: "Stage 13 rollback", image: "probe" },
            });
            throw new Error("STAGE13_ROLLBACK");
          }),
        /STAGE13_ROLLBACK/
      );
      assert.equal(await prisma.course.findUnique({ where: { id: STAGE13_PROBE_ID } }), null);

      await runSerializableTransaction(async (tx) => {
        await tx.course.create({
          data: { id: STAGE13_PROBE_ID, name: "Stage 13 serializable", image: "probe" },
        });
      });
      await prisma.course.delete({ where: { id: STAGE13_PROBE_ID } });
    } finally {
      await prisma.course.deleteMany({ where: { id: STAGE13_PROBE_ID } }).catch(() => undefined);
      await disconnectPrisma();
    }
  });
});
