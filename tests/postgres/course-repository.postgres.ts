import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaCourseRepository } from "../../src/app/modules/course/course.repository";
import { assertStage13Target, TEST_PREFIX } from "./helpers/stage13-target";

const A = `${TEST_PREFIX}course-a`;
const B = `${TEST_PREFIX}course-b`;

describe("Stage 15 Course repository (live stage13-dev)", () => {
  const repository = new PrismaCourseRepository();

  async function cleanup(): Promise<void> {
    await getPrismaClient().course.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
  }

  before(async () => {
    assertStage13Target();
    await cleanup();
  });

  after(async () => {
    await cleanup().catch(() => undefined);
    await disconnectPrisma();
  });

  it("returns Stage 14 reconciled courses and controlled test rows under legacy field names", async () => {
    const prisma = getPrismaClient();
    await prisma.course.create({
      data: {
        id: B,
        name: "Stage 15 B",
        image: "b.png",
        homeBasedSystems: ["windows", "mac"],
        createdAt: new Date("2026-01-02T03:04:05.678Z"),
        updatedAt: new Date("2026-02-03T04:05:06.789Z"),
      },
    });
    await prisma.course.create({ data: { id: A, name: "Stage 15 A", image: "a.png" } });

    const all = await repository.findAll();
    assert.ok(all.length >= 7, "5 reconciled Stage 14 courses + 2 test rows");

    const ours = all.filter((c) => c._id.startsWith(TEST_PREFIX));
    // id ASC ordering is deterministic.
    assert.deepEqual(ours.map((c) => c._id), [A, B]);

    // Null timestamps and the column default: keys absent, [] default.
    assert.deepEqual(ours[0], { _id: A, name: "Stage 15 A", image: "a.png", homeBasedSystems: [] });
    // Dates survive as Date instances with millisecond precision.
    assert.equal(ours[1].homeBasedSystems.join(","), "windows,mac");
    assert.equal((ours[1].createdAt as Date).toISOString(), "2026-01-02T03:04:05.678Z");
    assert.equal((ours[1].updatedAt as Date).toISOString(), "2026-02-03T04:05:06.789Z");
  });

  it("the five reconciled Stage 14 courses are all present with ObjectId-shaped ids", async () => {
    const all = await repository.findAll();
    const real = all.filter((c) => !c._id.startsWith(TEST_PREFIX));
    assert.equal(real.length, 5);
    for (const c of real) {
      assert.match(c._id, /^[0-9a-f]{24}$/);
      assert.equal(typeof c.name, "string");
      assert.equal(typeof c.image, "string");
    }
  });

  it("a Prisma failure is translated: no SQL, table, or Prisma class detail crosses the boundary", async () => {
    const failing = new PrismaCourseRepository(() => {
      const client = getPrismaClient();
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "course") {
            return {
              findMany: () => client.$queryRaw`SELECT * FROM stage15_table_that_does_not_exist`,
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
    await assert.rejects(
      () => failing.findAll(),
      (error: Error) => {
        assert.equal(error.name, "PersistenceError");
        assert.doesNotMatch(error.message, /SELECT|stage15_table|relation|Prisma/i);
        return true;
      }
    );
  });
});
