// Stage 15/16 hybrid persistence map (D-038/D-039): Auth/User/Course/Schedule
// (Stage 15) and Booking + teacher assignment (Stage 16) are on PostgreSQL via
// Prisma in the TS candidate; everything else stays on Mongo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCoreRepositories } from "../../src/app/runtime/core-repositories";
import { PrismaCourseRepository } from "../../src/app/modules/course/course.repository";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const MIGRATED = ["auth", "user", "course", "schedule", "booking"] as const;

function moduleFiles(name: string): string[] {
  const dir = path.join(root, "src/app/modules", name);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
}

describe("Stage 15 persistence map (architecture)", () => {
  it("only the repository file of each migrated module touches Prisma or MongoDB", () => {
    for (const name of MIGRATED) {
      for (const file of moduleFiles(name)) {
        const source = read(`src/app/modules/${name}/${file}`);
        const isRepository = file === `${name}.repository.ts`;
        const importsPrisma = /generated\/prisma|@prisma\//.test(source) || /database\/prisma"/.test(source);
        // ObjectId is imported from the driver only as an id-format validator
        // (ObjectId.isValid); persistence handles are what must never appear.
        const importsMongoDriver = /import[^;]*\b(Collection|Db|MongoClient|ClientSession|Document)\b[^;]*from "mongodb"|require\("mongodb"\)/.test(source);
        const importsAnyMongo = /from "mongodb"/.test(source);
        if (!isRepository) {
          assert.equal(importsPrisma, false, `${name}/${file} must not import Prisma`);
          assert.equal(importsMongoDriver, false, `${name}/${file} must not hold MongoDB persistence handles`);
        } else {
          assert.equal(importsPrisma, true, `${name}.repository.ts must be the Prisma boundary`);
          assert.equal(importsAnyMongo, false, `${name}.repository.ts must not import the MongoDB driver anymore`);
        }
      }
    }
  });

  it("migrated repositories never import Prisma/SQL error classes into callers or leak raw SQL outside the repository", () => {
    for (const name of MIGRATED) {
      for (const file of moduleFiles(name).filter((f) => f !== `${name}.repository.ts`)) {
        const source = read(`src/app/modules/${name}/${file}`);
        assert.doesNotMatch(source, /\$queryRaw|\$executeRaw|PrismaClient/, `${name}/${file}`);
      }
    }
  });

  it("the router wires Auth/User/Course/Schedule/Booking to the injected core repositories, not to Mongo collections", () => {
    const source = read("src/app/router/index.ts");
    for (const name of MIGRATED) {
      assert.match(source, new RegExp(`options\\.repositories\\.${name}`), `${name} repository injection`);
    }
    const nativeFactories = source.match(/create(Auth|User|Course|Schedule|Booking)Module\(\{[\s\S]*?\}\)/g) ?? [];
    assert.equal(nativeFactories.length >= 5, true);
    for (const call of nativeFactories) {
      assert.doesNotMatch(call, /Collection\b/, `native module wiring must not receive a Mongo collection: ${call.slice(0, 60)}`);
    }
  });

  it("Mongo-backed modules stay on Mongo: legacy routes and legacy auth still receive the collections", () => {
    const source = read("src/app/router/index.ts");
    assert.match(source, /usersCollection/);
    assert.match(source, /initLegacyAuth/);
    assert.match(source, /bookingMockCollection/);
  });

  it("core repository composition is explicit about the hybrid state and is lazy (no Prisma client at construction)", () => {
    const source = read("src/app/runtime/core-repositories.ts");
    assert.match(source, /PostgreSQL \/ Prisma \(stage13-dev\)/);
    assert.match(source, /MongoDB \(native driver\)/);
    assert.match(source, /no cross-database atomicity/i);
  });

  it("constructing the core repositories needs no database configuration (Stage 12.5 lazy runtime preserved)", async () => {
    const saved = { url: process.env.NEON_DB_URL, direct: process.env.NEON_DIRECT_URL };
    delete process.env.NEON_DB_URL;
    delete process.env.NEON_DIRECT_URL;
    try {
      const repositories = createCoreRepositories();
      assert.deepEqual(Object.keys(repositories).sort(), ["auth", "booking", "course", "schedule", "user"]);
    } finally {
      if (saved.url !== undefined) process.env.NEON_DB_URL = saved.url;
      if (saved.direct !== undefined) process.env.NEON_DIRECT_URL = saved.direct;
    }
  });

  it("a migrated repository fails closed with a sanitized error when PostgreSQL is not configured", async () => {
    const repository = new PrismaCourseRepository(() => {
      throw new Error("NEON_DB_URL is not configured");
    });
    await assert.rejects(() => repository.findAll(), /NEON_DB_URL is not configured/);
  });

  it("Better Auth is not activated: no runtime import and no auth tables are queried by src", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    assert.equal(Object.keys(pkg.dependencies ?? {}).some((d) => /better-auth|next-auth|mongoose/.test(d)), false);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(root, "src/app")).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(source, /better-auth/i, file);
      assert.doesNotMatch(source, /prisma\.(session|account|verification)\b|\.(session|account|verification)\.(find|create|update|delete)/, file);
    }
  });

  it("production guard: no repository or test in src can address a non-stage13-dev endpoint by name", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(root, "src")).filter((f) => f.endsWith(".ts"))) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /falling-brook/, file);
    }
  });
});
