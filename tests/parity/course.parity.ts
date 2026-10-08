// Stage 15 differential parity: Course.
//
// The SAME fixtures run through (a) the frozen pre-Stage-15 Mongo repository
// against a real ephemeral MongoDB and (b) the Stage 15 PostgreSQL repository
// against the real stage13-dev database. Differences must be declared with a
// reason (assertParity fails on any undeclared one).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaCourseRepository } from "../../src/app/modules/course/course.repository";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { MongoCourseReference } from "./reference-mongo/course.reference";
import { assertParity, newTestObjectId, PARITY_ID_PREFIX, toWire } from "./helpers/compare";

describe("Stage 15 parity: Course repository (Mongo reference vs PostgreSQL)", () => {
  let mongo: TransactionTestDb;
  const pg = new PrismaCourseRepository();
  const ids = [newTestObjectId(), newTestObjectId(), newTestObjectId()].sort((a, b) => a.toHexString().localeCompare(b.toHexString()));
  const [full, minimal, extra] = ids;

  before(async () => {
    assertStage13Target();
    mongo = await startTransactionTestDb();
    const createdAt = new Date("2026-03-04T05:06:07.890Z");
    const updatedAt = new Date("2026-04-05T06:07:08.901Z");

    await mongo.collections.coursesCollection.insertMany([
      { _id: full, name: "Parity Full", image: "full.png", homeBasedSystems: ["windows", "mac"], createdAt, updatedAt },
      { _id: minimal, name: "Parity Minimal", image: "min.png" },
      { _id: extra, name: "Parity Extra", image: "extra.png", homeBasedSystems: [], futureField: "legacy-only" },
    ]);

    const prisma = getPrismaClient();
    await prisma.course.deleteMany({ where: { id: { startsWith: PARITY_ID_PREFIX } } });
    await prisma.course.createMany({
      data: [
        { id: full.toHexString(), name: "Parity Full", image: "full.png", homeBasedSystems: ["windows", "mac"], createdAt, updatedAt },
        { id: minimal.toHexString(), name: "Parity Minimal", image: "min.png" },
        { id: extra.toHexString(), name: "Parity Extra", image: "extra.png", homeBasedSystems: [] },
      ],
    });
  });

  after(async () => {
    await getPrismaClient().course.deleteMany({ where: { id: { startsWith: PARITY_ID_PREFIX } } }).catch(() => undefined);
    await disconnectPrisma();
    await mongo?.teardown();
  });

  async function both(): Promise<{ mongo: Record<string, unknown>[]; pg: Record<string, unknown>[] }> {
    const m = (await new MongoCourseReference(mongo.collections.coursesCollection).findAll()) as Record<string, unknown>[];
    const p = (await pg.findAll()).filter((c) => c._id.startsWith(PARITY_ID_PREFIX)) as unknown as Record<string, unknown>[];
    return { mongo: m, pg: p };
  }

  it("found records: identical wire shape, ids, ordering, timestamps for fully-populated rows", async () => {
    const { mongo: m, pg: p } = await both();
    assert.deepEqual(m.map((c) => String(c._id)), ids.map((i) => i.toHexString()));
    assert.deepEqual(p.map((c) => c._id), ids.map((i) => i.toHexString()));
    assertParity(m[0], p[0], [], "full course");
  });

  it("optional/null fields: absent timestamps stay absent; missing homeBasedSystems is the only intentional difference", async () => {
    const { mongo: m, pg: p } = await both();
    assertParity(m[1], p[1], [
      { path: "homeBasedSystems", mongo: undefined, postgres: [], reason: "NOT NULL DEFAULT [] column (relational-model-plan: absent-with-contract-default)" },
    ], "minimal course");
    assert.ok(!("createdAt" in (toWire(p[1]) as object)));
  });

  it("unmodeled document fields are not carried (intentional: no PostgreSQL column; reported by Stage 14 as undeclared)", async () => {
    const { mongo: m, pg: p } = await both();
    assertParity(m[2], p[2], [
      { path: "futureField", mongo: "legacy-only", postgres: undefined, reason: "field has no Stage 13 column" },
    ], "extra-field course");
  });

  it("empty result: both return [] (filtered to this suite's rows)", async () => {
    await mongo.collections.coursesCollection.deleteMany({});
    await getPrismaClient().course.deleteMany({ where: { id: { startsWith: PARITY_ID_PREFIX } } });
    const { mongo: m, pg: p } = await both();
    assert.deepEqual(m, []);
    assert.deepEqual(p, []);
  });
});
