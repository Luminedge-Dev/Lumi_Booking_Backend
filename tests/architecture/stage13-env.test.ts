import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseBooleanEnv,
  parseCorsOriginsEnv,
  parseNonNegativeIntegerEnv,
  parsePositiveIntegerEnv,
  resolveTrustProxyHops,
} from "../../src/app/config/env.utils";
import { buildEnvVars, buildPostgresEnv } from "../../src/app/config/env";
import { classifyDatabaseUrl, normalizedEndpointId } from "../../src/app/database/neon-target";
import { getPrismaClient } from "../../src/app/database/prisma";
import { isTransactionConflict, runSerializableTransaction } from "../../src/app/database/transaction";

const baseEnv: NodeJS.ProcessEnv = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/luminedge",
  JWT_SECRET: "test-only-secret",
  JWT_RESET_PASS_SECRET: "test-only-reset-secret",
  CORS_ORIGINS: "http://localhost:3000",
};

describe("env parsers (architecture)", () => {
  it("rejects malformed trust-proxy and integer values without coercing them", () => {
    for (const raw of ["-1", "1.5", "NaN", "1e2", "08", ""]) {
      assert.throws(() => parseNonNegativeIntegerEnv(raw, "TRUST_PROXY_HOPS"), /TRUST_PROXY_HOPS/);
    }
    assert.equal(parseNonNegativeIntegerEnv("0", "TRUST_PROXY_HOPS"), 0);
    assert.throws(() => parsePositiveIntegerEnv("0", "PORT"), /PORT/);
    assert.throws(() => parseBooleanEnv("yes", "SMTP_SECURE"), /SMTP_SECURE/);
    assert.equal(parseBooleanEnv("true", "SMTP_SECURE"), true);
  });

  it("defaults trust proxy hops to 1 only when the variable is absent", () => {
    assert.equal(resolveTrustProxyHops({}), 1);
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "3" }), 3);
    assert.throws(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: "nope" }), /TRUST_PROXY_HOPS/);
  });

  it("Mongo runtime config does not require NEON_DB_URL", () => {
    const config = buildEnvVars(baseEnv);
    assert.deepEqual(config.corsOrigins, ["http://localhost:3000"]);
    assert.equal(config.trustProxyHops, 1);
    assert.equal("databaseUrl" in config, false);
  });

  it("PostgreSQL config requires NEON_DB_URL and does not read it during Mongo config", () => {
    assert.throws(() => buildPostgresEnv(baseEnv), /NEON_DB_URL/);
    const postgres = buildPostgresEnv({ ...baseEnv, NEON_DB_URL: "postgresql://db.example/luminedge_stage13" });
    assert.equal(postgres.databaseUrl.includes("luminedge_stage13"), true);
  });

  it("rejects an empty CORS allowlist", () => {
    assert.throws(() => parseCorsOriginsEnv(" , "), /CORS_ORIGINS/);
    assert.throws(() => buildEnvVars({ ...baseEnv, CORS_ORIGINS: undefined }), /CORS_ORIGINS/);
  });
});

describe("Neon target classification (architecture)", () => {
  it("reports provider, database, and pool mode without treating a Neon host as non-production", () => {
    const pooled = classifyDatabaseUrl(
      "postgresql://user:secret@ep-example-pooler.neon.tech/luminedge_stage13?sslmode=require"
    );
    assert.equal(pooled.provider, "neon");
    assert.equal(pooled.database, "luminedge_stage13");
    assert.equal(pooled.pooled, true);
    assert.equal(pooled.hostSuffix, "neon.tech");
    assert.equal(pooled.environmentClassification, "unproven");
    assert.equal(JSON.stringify(pooled).includes("secret"), false);
    assert.equal(JSON.stringify(pooled).includes("user"), false);

    const direct = classifyDatabaseUrl("postgresql://user:secret@ep-example.neon.tech/luminedge_stage13");
    assert.equal(direct.pooled, false);
    assert.equal(
      normalizedEndpointId("postgresql://user:secret@ep-example-pooler.neon.tech/luminedge_stage13"),
      normalizedEndpointId("postgresql://user:secret@ep-example.neon.tech/luminedge_stage13")
    );
  });

  it("rejects a non-PostgreSQL URL", () => {
    assert.throws(() => classifyDatabaseUrl("mongodb://cluster.mongodb.net/luminedge"), /PostgreSQL/);
  });
});

describe("transaction conflict classification (architecture)", () => {
  it("retries only the Prisma transaction-conflict code", () => {
    assert.equal(isTransactionConflict({ code: "P2034" }), true);
    assert.equal(isTransactionConflict({ code: "P2002" }), false);
    assert.equal(isTransactionConflict(new Error("P2034")), false);
  });

  it("bounds Serializable retries and does not retry other errors", async () => {
    let conflicts = 0;
    const value = await runSerializableTransaction(async () => "ok", {
      maxAttempts: 3,
      backoffMs: 0,
      execute: async () => {
        conflicts += 1;
        if (conflicts < 3) throw { code: "P2034" };
        return "ok";
      },
    });
    assert.equal(value, "ok");
    assert.equal(conflicts, 3);

    let otherAttempts = 0;
    await assert.rejects(
      () =>
        runSerializableTransaction(async () => "nope", {
          maxAttempts: 3,
          backoffMs: 0,
          execute: async () => {
            otherAttempts += 1;
            throw new Error("permanent");
          },
        }),
      /permanent/
    );
    assert.equal(otherAttempts, 1);

    let exhausted = 0;
    await assert.rejects(
      () =>
        runSerializableTransaction(async () => "nope", {
          maxAttempts: 2,
          backoffMs: 0,
          execute: async () => {
            exhausted += 1;
            throw { code: "P2034" };
          },
        }),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "P2034"
    );
    assert.equal(exhausted, 2);
  });
});

describe("Prisma URL ownership (architecture)", () => {
  it("sends Prisma CLI to the direct URL and the runtime client to the pooled URL", () => {
    const config = readFileSync(path.join(process.cwd(), "prisma.config.ts"), "utf8");
    const runtime = readFileSync(path.join(process.cwd(), "src", "app", "database", "prisma.ts"), "utf8");
    assert.match(config, /env\("NEON_DIRECT_URL"\)/);
    assert.doesNotMatch(config, /NEON_DB_URL/);
    assert.match(runtime, /getPostgresEnv\(\)\.databaseUrl/);
  });
});

describe("import safety (architecture)", () => {
  it("loading the Prisma module does not require NEON_DB_URL or open a connection", () => {
    assert.equal(typeof getPrismaClient, "function");
    assert.equal(typeof runSerializableTransaction, "function");
    assert.throws(() => buildPostgresEnv(baseEnv), /NEON_DB_URL/);
  });
});
