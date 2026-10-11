import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { TABLES } from "../../../scripts/migration/stage14/common";
import { runPipeline } from "../../../scripts/migration/stage14/pipeline";
import { buildWorld } from "../../migration/stage14/helpers/fixtures";
import { memorySource } from "../../migration/stage14/helpers/memory";
import { aggregateQuarantine } from "../../../scripts/migration/stage17/local-dry-run";
import { accumulateNormalization, emptyTally, finishTally } from "../../../scripts/migration/stage17/normalization-tally";
import { assertLocalReader, parseLocalMongoUri } from "../../../scripts/migration/stage17/privilege";
import { assertReportSafe, sanitizePath } from "../../../scripts/migration/stage17/sanitize";

const BACKEND = path.resolve(__dirname, "../../../");
const STAGE17 = path.join(BACKEND, "scripts", "migration", "stage17");

function walkValueImports(file: string, seen = new Set<string>()): string[] {
  const resolved = path.resolve(file);
  if (seen.has(resolved) || !fs.existsSync(resolved)) return [...seen];
  seen.add(resolved);
  const text = fs.readFileSync(resolved, "utf8");
  for (const match of text.matchAll(/^import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/gm)) {
    const spec = match[1]!;
    if (!spec.startsWith(".")) continue;
    const base = path.resolve(path.dirname(resolved), spec);
    const candidate = [base, `${base}.ts`, path.join(base, "index.ts")].find((item) => fs.existsSync(item) && fs.statSync(item).isFile());
    if (candidate) walkValueImports(candidate, seen);
  }
  return [...seen];
}

describe("Stage 17 local dry-run isolation", () => {
  it("keeps the Stage 14 source pinned to the luminedge database", () => {
    const source = fs.readFileSync(path.join(BACKEND, "scripts", "migration", "stage14", "extract", "source.ts"), "utf8");
    assert.match(source, /const MONGO_DB_NAME = "luminedge"/);
    assert.match(source, /return connectReadOnlyDatabase\(uri, MONGO_DB_NAME\)/);
    const runner = fs.readFileSync(path.join(BACKEND, "scripts", "migration", "stage14", "runner.ts"), "utf8");
    assert.match(runner, /connectReadOnlySource\(config\.mongoUri\)/);
    assert.doesNotMatch(runner, /connectReadOnlyDatabase/);
    const guards = fs.readFileSync(path.join(BACKEND, "scripts", "migration", "stage14", "guards.ts"), "utf8");
    assert.match(guards, /ep-rapid-bread-b4gi8ftb/);
  });

  it("does not import the runner, config, loader, reconcile, or Prisma", () => {
    const files = walkValueImports(path.join(STAGE17, "local-dry-run.ts"));
    const joined = files.map((file) => path.relative(BACKEND, file).replace(/\\/g, "/")).join("\n");
    assert.match(joined, /scripts\/migration\/stage14\/pipeline\.ts/);
    assert.doesNotMatch(joined, /runner\.ts|config\.ts|guards\.ts|loader\.ts|reconcile\.ts|target-reader|prisma|dotenv/);
    for (const file of fs.readdirSync(STAGE17)) {
      const text = fs.readFileSync(path.join(STAGE17, file), "utf8");
      assert.doesNotMatch(text, /process\.env\.MONGODB_URI|dotenv|createPrismaSink|from ["'][^"']*loader|from ["'][^"']*runner|from ["'][^"']*\/config|from ["'][^"']*guards|from ["'][^"']*reconcile/);
      assert.doesNotMatch(text, /\b(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\b/);
    }
    const harness = fs.readFileSync(path.join(STAGE17, "local-dry-run.ts"), "utf8");
    assert.match(harness, /runPipeline\(\{/);
    assert.doesNotMatch(harness, /sink\s*:/);
  });

  it("accepts only the local reader on the snapshot database", () => {
    const parsed = parseLocalMongoUri("mongodb://reader:secret@127.0.0.1:27017/admin");
    assert.deepEqual({ host: parsed.host, port: parsed.port, username: parsed.username, pathname: parsed.pathname }, {
      host: "127.0.0.1",
      port: "27017",
      username: "reader",
      pathname: "/admin",
    });
    assert.throws(() => parseLocalMongoUri("mongodb+srv://reader:secret@cluster.example.net/admin"));
    assert.throws(() =>
      assertLocalReader({
        host: "127.0.0.1",
        port: "27017",
        username: "reader",
        databaseName: "luminedge",
        authenticatedUsers: [{ user: "reader", db: "admin" }],
        actions: ["find"],
      })
    );
    assert.throws(() =>
      assertLocalReader({
        host: "127.0.0.1",
        port: "27017",
        username: "reader",
        databaseName: "luminedge_stage17_snapshot_20261008",
        authenticatedUsers: [{ user: "reader", db: "admin" }],
        actions: ["find", "insert"],
      })
    );
    assert.doesNotThrow(() =>
      assertLocalReader({
        host: "127.0.0.1",
        port: "27017",
        username: "reader",
        databaseName: "luminedge_stage17_snapshot_20261008",
        authenticatedUsers: [{ user: "reader", db: "admin" }],
        actions: ["find", "listCollections"],
      })
    );
  });

  it("counts repeated slot changes and does not record preserved map keys", () => {
    const world = buildWorld();
    const schedule = {
      ...world.schedule,
      timeSlots: [
        { slot: 1, slotId: "1", totalSlot: "8", startTime: "09:00", endTime: "10:00" },
        { slot: 1, slotId: "2", totalSlot: "9", startTime: "11:00", endTime: "12:00" },
      ],
    };
    const tally = emptyTally();
    accumulateNormalization("schedules", schedule, tally);
    accumulateNormalization("schedules", { _id: new ObjectId(), totalSlot: "5" }, tally);
    accumulateNormalization("users", world.userA, tally);
    const finished = finishTally(tally);
    const encoded = JSON.stringify(finished);
    assert.equal(finished.changes.filter((row) => row.field === "schedules.timeSlots[].totalSlot").reduce((sum, row) => sum + row.count, 0), 2);
    assert.equal(finished.documents.schedules.rejected, 1);
    const hex = world.ids.schedule.toHexString();
    assert.equal(encoded.includes(hex), false);
    assert.equal(encoded.includes("l@example.com"), false);
    assert.equal(encoded.includes(sanitizePath(hex)), false);
  });

  it("strips map keys before a report is considered safe", () => {
    const key = "507f1f77bcf86cd799439011";
    assert.equal(sanitizePath(`teachersBySchedule.${key}`), "teachersBySchedule.<id>");
    assert.throws(() => assertReportSafe(`teachersBySchedule.${key}`));
    assert.doesNotThrow(() => assertReportSafe("teachersBySchedule.<id> string number 964"));
    const aggregated = aggregateQuarantine(
      [
        {
          entity: "users",
          kind: "teacher_assignments",
          sourceId: key,
          scope: `teachersBySchedule.${key}`,
          code: "NOT_A_REAL_STAGE14_CODE",
          field: "teacherLEmail",
          summary: "static",
          units: 1,
        },
      ],
      new Set(["USER_NOT_FOUND_IN_SOURCE"])
    );
    assert.deepEqual(aggregated.unknown, ["NOT_A_REAL_STAGE14_CODE"]);
    assert.equal(aggregated.rows[0]?.scope, "teachersBySchedule.<id>");
    assert.equal(JSON.stringify(aggregated.rows).includes(key), false);
  });

  it("leaves committed and skipped at 0 when the pipeline has no sink", async () => {
    const world = buildWorld("65000000000000000000");
    const pipeline = await runPipeline({
      source: memorySource({
        users: [world.userA, world.userB],
        courses: [world.course],
        schedules: [world.schedule],
        bookingMock: [world.testCenterBooking, world.homeBooking],
      }),
      batchSize: 10,
      userBatchSize: 10,
    });
    assert.equal(pipeline.mode, "dry-run");
    for (const table of TABLES) {
      const line = pipeline.ledger.line(table);
      assert.equal(line.committed, 0);
      assert.equal(line.skipped, 0);
      assert.equal(line.source, line.accepted + line.quarantined + line.skipped);
    }
  });
});
