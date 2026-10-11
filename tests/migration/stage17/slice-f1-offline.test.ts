import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { STAGE13_DEV_ENDPOINT_ID, isVerifiedStage13Target, verifyStage13Target } from "../../../scripts/migration/stage14/guards";
import { createPrismaSink } from "../../../scripts/migration/stage14/load/loader";
import { runPipeline } from "../../../scripts/migration/stage14/pipeline";
import { parseStage17Args } from "../../../scripts/migration/stage17/cli";
import { assertLocalUriShape } from "../../../scripts/migration/stage17/local-source";
import { executeClassify, executeDryRun, executeReview } from "../../../scripts/migration/stage17/orchestrate";
import { runStage17 } from "../../../scripts/migration/stage17/runner";
import {
  compareSourceManifests,
  FUTURE_LOCAL_SNAPSHOT_INVENTORY,
  finalizeManifestPair,
  manifestPath,
  readSourceManifest,
  sourceDocumentDigest,
} from "../../../scripts/migration/stage17/source-manifest";
import { assertReportSafe } from "../../../scripts/migration/stage17/sanitize";
import { buildWorld, userDoc } from "../stage14/helpers/fixtures";
import { memorySource } from "../stage14/helpers/memory";
import type { RawDoc } from "../../../scripts/migration/stage14/common";

const BACKEND = path.resolve(__dirname, "../../../");
const STAGE17 = path.join(BACKEND, "scripts", "migration", "stage17");
const POOLED = `postgresql://user:secret@${STAGE13_DEV_ENDPOINT_ID}-pooler.c-2.us-east-1.aws.neon.tech/neondb`;
const DIRECT = `postgresql://user:secret@${STAGE13_DEV_ENDPOINT_ID}.c-2.us-east-1.aws.neon.tech/neondb`;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage17-f1-"));
}

function emptySource() {
  const scan = { before: 0, extracted: 0, after: 0 };
  return {
    executionId: "00000000-0000-4000-8000-000000000001",
    digestVersion: "source-identity-v1" as const,
    encodingVersion: "stage17-bson-tagged-v2" as const,
    scan: { users: scan, courses: scan, schedules: scan, bookingMock: scan },
    entities: {
      users: { documents: [] },
      courses: { documents: [] },
      schedules: { documents: [] },
      bookingMock: { documents: [] },
    },
  };
}

function course(id: ObjectId, name = "IELTS Academic"): RawDoc {
  return { _id: id, name, image: "https://example.com/i.png", homeBasedSystems: ["Zoom"], createdAt: new Date("2024-01-01T00:00:00.000Z"), updatedAt: new Date("2024-01-02T00:00:00.000Z") };
}

describe("Stage 17 Slice F1 offline", () => {
  it("parses the three modes and rejects write modes and unsafe ids", () => {
    assert.equal(parseStage17Args(["dry-run", "--run-id", "f1-local"]).mode, "dry-run");
    assert.equal(parseStage17Args(["dry-run", "--run-id", "f1-local", "--policy", "FUTURE_FRESH_SOURCE"]).policy, "FUTURE_FRESH_SOURCE");
    assert.equal(parseStage17Args(["classify", "--earlier", "earlier", "--later", "later"]).mode, "classify");
    assert.equal(parseStage17Args(["review", "--ack", "stage17-rehearsal"]).acknowledgement, "stage17-rehearsal");
    assert.throws(() => parseStage17Args(["load"]), /mode must be/);
    assert.throws(() => parseStage17Args(["cleanup"]), /mode must be/);
    assert.throws(() => parseStage17Args(["reconcile"]), /mode must be/);
    assert.throws(() => parseStage17Args(["branch-create"]), /mode must be/);
    assert.throws(() => parseStage17Args(["dry-run"]), /requires --run-id/);
    assert.throws(() => parseStage17Args(["review", "--ack", "stage13-dev"]), /acknowledgement/);
    assert.throws(() => parseStage17Args(["dry-run", "--run-id", "f1-local", "--target", "stage13-dev"]), /unexpected/);
  });

  it("imports no database client and creates no sink", () => {
    for (const name of ["cli.ts", "orchestrate.ts", "source-manifest.ts", "evidence.ts", "runner.ts"]) {
      const text = fs.readFileSync(path.join(STAGE17, name), "utf8");
      assert.doesNotMatch(text, /createPrismaSink|MongoClient|getPrismaClient|PrismaNeon|from ["'][^"']*loader|from ["'][^"']*runner|from ["'][^"']*\/config|from ["'][^"']*guards|from ["'][^"']*reconcile|dotenv|process\.env\.MONGODB_URI|NEON_DB_URL/);
    }
  });

  it("distinguishes BSON types and ignores object key order", () => {
    const id = "same-id";
    const base = { _id: id, label: "one" };
    assert.equal(sourceDocumentDigest(base), sourceDocumentDigest({ label: "one", _id: id }));
    assert.equal(sourceDocumentDigest(base).length, 64);
    const values = [1, new Int32(1), new Double(1), Long.fromInt(1), "1", new ObjectId("6517000000000000000000aa"), new Date("2024-01-01T00:00:00.000Z"), Decimal128.fromString("1")];
    const digests = values.map((value) => sourceDocumentDigest({ _id: id, n: value }));
    assert.equal(new Set(digests).size, values.length);
    assert.notEqual(sourceDocumentDigest({ _id: id, n: null }), sourceDocumentDigest({ _id: id }));
    assert.notEqual(sourceDocumentDigest({ _id: id, when: new Date("2024-01-01T00:00:00.000Z") }), sourceDocumentDigest({ _id: id, when: "2024-01-01T00:00:00.000Z" }));
    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0];
    const nonFiniteDigests = nonFinite.map((value) => sourceDocumentDigest({ _id: id, n: value }));
    assert.equal(new Set(nonFiniteDigests).size, nonFinite.length);
    const doubleValues = [new Double(Number.NaN), new Double(Number.POSITIVE_INFINITY), new Double(Number.NEGATIVE_INFINITY), new Double(-0), new Double(0)];
    const doubleDigests = doubleValues.map((value) => sourceDocumentDigest({ _id: id, n: value }));
    assert.equal(new Set(doubleDigests).size, doubleValues.length);
    assert.notEqual(sourceDocumentDigest({ _id: id, n: Number.NaN }), sourceDocumentDigest({ _id: id, n: new Double(Number.NaN) }));
    assert.equal(sourceDocumentDigest({ _id: id, n: Number.NaN }), sourceDocumentDigest({ n: Number.NaN, _id: id }));
    assert.throws(() => sourceDocumentDigest({ _id: id, pattern: /secret/ }), /unsupported source value/);
  });

  it("observes every Stage 14 root once and does not change an unobserved run", async () => {
    const world = buildWorld("65170000000000000000");
    const data = {
      users: [world.userA, world.userB],
      courses: [world.course],
      schedules: [world.schedule],
      bookingMock: [world.testCenterBooking, world.homeBooking],
    };
    const plain = await runPipeline({ source: memorySource(data), batchSize: 10, userBatchSize: 10 });
    let observed = 0;
    const watching = await runPipeline({
      source: memorySource(data),
      batchSize: 10,
      userBatchSize: 10,
      onDocument: () => {
        observed += 1;
      },
    });
    assert.equal(observed, 6);
    assert.equal(watching.mode, "dry-run");
    assert.deepEqual(watching.ledger.snapshot(), plain.ledger.snapshot());
    assert.equal(watching.quarantine.length, plain.quarantine.length);
    assert.deepEqual(watching.expectation.toManifest(), plain.expectation.toManifest());
    for (const line of Object.values(watching.ledger.snapshot())) assert.equal(line.committed, 0);
  });

  it("separates root quarantine from child quarantine and keeps extraction local", async () => {
    const root = tempRoot();
    try {
      const courseId = new ObjectId("6517000000000000000000c1");
      const badId = new ObjectId("6517000000000000000000c2");
      const scheduleId = new ObjectId("6517000000000000000000a1");
      const outcome = await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "child-root" },
        allowTestRoot: true,
        manifestRoot: root,
        source: memorySource({
          courses: [course(courseId), { _id: badId, image: "https://example.com/i.png", homeBasedSystems: ["Zoom"] }],
          schedules: [
            {
              _id: scheduleId,
              name: "Jan Batch",
              courseId,
              createdAt: new Date("2024-01-01T00:00:00.000Z"),
              testType: "Computer-Based",
              testSystem: "Academic",
              status: "Scheduled",
              startDate: "2024-02-01",
              endDate: "2024-02-01",
              timeSlots: [{ slot: 18, slotId: "x", totalSlot: 20, startTime: "09:00", endTime: "11:00" }],
            },
          ],
        }),
      });
      assert.equal(outcome.status, "complete");
      assert.equal(outcome.pipeline?.mode, "dry-run");
      const courses = outcome.sourceManifest!.entities.courses.documents;
      const schedules = outcome.sourceManifest!.entities.schedules.documents;
      assert.equal(courses.length, 2);
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0]!.outcome, "accepted");
      assert.deepEqual(schedules[0]!.childReasonCodes, ["NON_NUMERIC_SLOT_ID"]);
      assert.equal(courses.filter((item) => item.outcome === "root-quarantined").length, 1);
      assert.equal(outcome.sourceManifest!.entities.users.documents.length, 0);
      assert.equal(outcome.sourceManifest!.entities.bookingMock.documents.length, 0);
      assertReportSafe(outcome.report);
      assert.throws(() => executeDryRun({ command: { mode: "dry-run", policy: "FUTURE_FRESH_SOURCE", runId: "remote" }, allowTestRoot: true, manifestRoot: root, source: memorySource({}) }), /LOCAL_SNAPSHOT/);
      await assert.rejects(() => runStage17(["dry-run", "--run-id", "offline"]), /not authorized/);
      await assert.rejects(() => runStage17(["dry-run", "--run-id", "offline"], { connectLocal: true, env: {} }), /STAGE17_LOCAL_MONGODB_URI is required/);
      const remote = "mongodb://reader:secret@10.0.0.8:27017/admin";
      assert.throws(() => assertLocalUriShape(remote), (error: unknown) => {
        assert.match((error as Error).message, /local MongoDB server/);
        assert.doesNotMatch((error as Error).message, /secret/);
        return true;
      });
      assert.throws(() => assertLocalUriShape("mongodb+srv://reader:secret@cluster.example.net/admin"), /SRV/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies source changes and transform transitions without calling absence a deletion", async () => {
    const root = tempRoot();
    try {
      const courseId = new ObjectId("6517000000000000000000c1");
      const userA = new ObjectId("6517000000000000000000b1");
      const userB = new ObjectId("6517000000000000000000b2");
      const userQ = new ObjectId("6517000000000000000000b3");
      const userC = new ObjectId("6517000000000000000000b4");
      const sharedCourse = course(courseId);
      await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "earlier" },
        allowTestRoot: true,
        manifestRoot: root,
        source: memorySource({ courses: [sharedCourse], users: [userDoc(userA), userDoc(userB), userDoc(userQ, { status: null })] }),
      });
      await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "later" },
        allowTestRoot: true,
        manifestRoot: root,
        source: memorySource({
          courses: [sharedCourse],
          users: [userDoc(userA, { status: null, name: "Changed Name" }), userDoc(userQ, { name: "Restored" }), userDoc(userC, { status: null })],
        }),
      });
      const classified = executeClassify(root, "earlier", "later", true);
      assert.equal(classified.source.sourceAdded, 1);
      assert.equal(classified.source.sourceDeleted, 1);
      assert.equal(classified.source.sourceModified, 2);
      assert.equal(classified.source.sourceUnchanged, 1);
      assert.equal(classified.source.acceptedToQuarantined, 1);
      assert.equal(classified.source.quarantinedToAccepted, 1);
      assert.equal(classified.source.addedAndRootQuarantined, 1);
      assert.equal(classified.source.modifiedAndRootQuarantined, 1);
      assert.equal(readSourceManifest(manifestPath(root, "earlier", "source-identity.json")).entities.users.documents.length, 3);
      assert.equal(readSourceManifest(manifestPath(root, "later", "source-identity.json")).entities.users.documents.length, 3);
      assert.ok(classified.canonical.canonicalRowsAbsent > classified.source.sourceDeleted);
      assert.match(classified.report, /canonicalRowsAbsent is not a confirmed MongoDB deletion/);
      assert.doesNotMatch(classified.report, /6517000000000000000000/);
      assertReportSafe(classified.report);
      const duplicate = new ObjectId("6517000000000000000000b9");
      const duplicated = await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "dup" },
        allowTestRoot: true,
        manifestRoot: root,
        source: memorySource({ users: [userDoc(duplicate), userDoc(duplicate)] }),
      });
      assert.equal(duplicated.status, "blocked");
      assert.match(duplicated.report, /BLOCKED|blocked: source identity is not unique/);
      assert.doesNotMatch(duplicated.report, /6517000000000000000000/);
      assert.equal(fs.existsSync(path.join(root, "dup")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths, bad versions, and incomplete manifests", () => {
    const root = tempRoot();
    try {
      assert.throws(() => manifestPath(root, "a..b", "source-identity.json"), /run id is not safe/);
      assert.throws(() => manifestPath(root, "../escape", "source-identity.json"), /run id is not safe/);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stage17-f1-out-"));
      const link = path.join(root, "linked");
      try {
        fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
        assert.throws(
          () =>
            finalizeManifestPair({
              root,
              runId: "linked",
              allowTestRoot: true,
              executionId: "00000000-0000-4000-8000-000000000001",
              source: emptySource(),
              canonical: { digestVersion: "stage14-row-digest-v1", tables: {} },
            }),
          /symlink/
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") throw error;
      }
      fs.mkdirSync(path.join(root, "broken"), { recursive: true });
      fs.writeFileSync(path.join(root, "broken", "source-identity.json"), "{");
      assert.throws(() => readSourceManifest(path.join(root, "broken", "source-identity.json")), /incomplete/);
      const valid = {
        executionId: "00000000-0000-4000-8000-000000000001",
        digestVersion: "other-version",
        encodingVersion: "stage17-bson-tagged-v2",
        scan: { users: { before: 0, extracted: 0, after: 0 }, courses: { before: 0, extracted: 0, after: 0 }, schedules: { before: 0, extracted: 0, after: 0 }, bookingMock: { before: 0, extracted: 0, after: 0 } },
        entities: { users: { documents: [] }, courses: { documents: [] }, schedules: { documents: [] }, bookingMock: { documents: [] } },
      };
      fs.mkdirSync(path.join(root, "version"), { recursive: true });
      fs.writeFileSync(path.join(root, "version", "source-identity.json"), JSON.stringify(valid));
      assert.throws(() => readSourceManifest(path.join(root, "version", "source-identity.json")), /digest version/);
      const missing = { ...valid, digestVersion: "source-identity-v1", entities: { users: { documents: [] }, courses: { documents: [] }, schedules: { documents: [] } } };
      fs.mkdirSync(path.join(root, "missing"), { recursive: true });
      fs.writeFileSync(path.join(root, "missing", "source-identity.json"), JSON.stringify(missing));
      assert.throws(() => readSourceManifest(path.join(root, "missing", "source-identity.json")), /incomplete/);
      const empty = emptySource();
      finalizeManifestPair({ root, runId: "empty-a", allowTestRoot: true, executionId: empty.executionId, source: empty, canonical: { digestVersion: "stage14-row-digest-v1", tables: {} } });
      finalizeManifestPair({ root, runId: "empty-b", allowTestRoot: true, executionId: "00000000-0000-4000-8000-000000000002", source: { ...empty, executionId: "00000000-0000-4000-8000-000000000002" }, canonical: { digestVersion: "stage14-row-digest-v1", tables: {} } });
      const compared = compareSourceManifests(readSourceManifest(manifestPath(root, "empty-a", "source-identity.json")), readSourceManifest(manifestPath(root, "empty-b", "source-identity.json")));
      assert.equal(compared.sourceAdded + compared.sourceDeleted + compared.sourceModified + compared.sourceUnchanged, 0);
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reviews cleanup without granting execution", () => {
    const approved = {
      projectId: "proj-test",
      parentBranchId: "br-parent",
      parentBranchName: "stage13-dev" as const,
      childBranchName: "stage17-rehearsal-test",
      endpointId: "ep-rehearsal-test",
    };
    const reviewed = executeReview({
      guard: {
        acknowledgement: "stage17-rehearsal",
        pooledUrl: "postgresql://role:secret@ep-rehearsal-test-pooler.region.neon.tech/neondb",
        directUrl: "postgresql://role:secret@ep-rehearsal-test.region.neon.tech/neondb",
        approved,
        metadata: {
          projectId: approved.projectId,
          parentBranchId: approved.parentBranchId,
          parentBranchName: "stage13-dev",
          childBranchId: "br-child",
          childBranchName: approved.childBranchName,
          endpointIds: [approved.endpointId],
        },
      },
      referencers: [{ referencingTable: "sessions", referencedTable: "users" }],
      identity: { sessions: 0, accounts: 0, verifications: 0 },
    });
    assert.equal(reviewed.executionAuthority, "none");
    assert.equal(reviewed.liveEvidence, "not-attested");
    assert.match(reviewed.statementPreview, /^TRUNCATE TABLE public\.sessions,/);
    assert.doesNotMatch(reviewed.statementPreview, /\bCASCADE\b|\bDROP\b/i);
    assertReportSafe(reviewed.report);
    assert.throws(
      () =>
        executeReview({
          guard: {
            acknowledgement: "stage17-rehearsal",
            pooledUrl: "postgresql://role:secret@ep-rehearsal-test-pooler.region.neon.tech/neondb",
            directUrl: "postgresql://role:secret@ep-rehearsal-test.region.neon.tech/neondb",
            approved,
            metadata: {
              projectId: approved.projectId,
              parentBranchId: approved.parentBranchId,
              parentBranchName: "stage13-dev",
              childBranchId: "br-child",
              childBranchName: approved.childBranchName,
              endpointIds: [approved.endpointId],
            },
          },
          referencers: [{ referencingTable: "sessions", referencedTable: "users" }],
          identity: { sessions: 1, accounts: 0, verifications: 0 },
        }),
      /identity tables/
    );
  });

  it("digests a quarantined non-finite user before any later mutation and blocks a bad scan", async () => {
    const root = tempRoot();
    try {
      const userId = new ObjectId("6517000000000000000000c9");
      const original = userDoc(userId, { mock: Number.NaN, totalMock: Number.POSITIVE_INFINITY });
      const preimage = sourceDocumentDigest(original);
      const outcome = await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "nonfinite" },
        allowTestRoot: true,
        manifestRoot: root,
        source: memorySource({ users: [original] }),
      });
      assert.equal(outcome.status, "complete");
      const record = outcome.sourceManifest!.entities.users.documents[0]!;
      assert.equal(record.outcome, "root-quarantined");
      assert.equal(record.digest, preimage);
      assert.equal(record.digest.length, 64);
      original.mock = 1;
      assert.notEqual(sourceDocumentDigest(original), preimage);
      assert.equal(outcome.pipeline?.ledger.snapshot().users?.committed, 0);
      assert.match(outcome.report, /not point-in-time consistency/);
      const limited = await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "partial" },
        allowTestRoot: true,
        manifestRoot: root,
        limitPerEntity: 1,
        source: memorySource({ users: [userDoc(new ObjectId("6517000000000000000000d1")), userDoc(new ObjectId("6517000000000000000000d2"))] }),
      });
      assert.equal(limited.status, "blocked");
      assert.match(limited.report, /count agreement failed/);
      assert.equal(fs.existsSync(path.join(root, "partial")), false);
      const inventory = await executeDryRun({
        command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "inventory" },
        allowTestRoot: true,
        manifestRoot: root,
        checkSnapshotInventory: true,
        source: memorySource({ courses: [course(new ObjectId("6517000000000000000000c3"))] }),
      });
      assert.equal(inventory.status, "blocked");
      assert.equal(fs.existsSync(path.join(root, "inventory")), false);
      assert.equal(FUTURE_LOCAL_SNAPSHOT_INVENTORY.users, 9205);
      assert.equal(FUTURE_LOCAL_SNAPSHOT_INVENTORY.courses, 5);
      assert.equal(FUTURE_LOCAL_SNAPSHOT_INVENTORY.schedules, 2457);
      assert.equal(FUTURE_LOCAL_SNAPSHOT_INVENTORY.bookingMock, 21210);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses another output directory, a repeated run, and a split manifest pair", async () => {
    const root = tempRoot();
    try {
      await assert.rejects(
        () => executeDryRun({ command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "outside" }, manifestRoot: root, source: memorySource({}) }),
        /approved directory/
      );
      await executeDryRun({ command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "once" }, allowTestRoot: true, manifestRoot: root, source: memorySource({}) });
      await assert.rejects(
        () => executeDryRun({ command: { mode: "dry-run", policy: "LOCAL_SNAPSHOT", runId: "once" }, allowTestRoot: true, manifestRoot: root, source: memorySource({}) }),
        /run id already exists/
      );
      fs.rmSync(path.join(root, "once", "canonical-rows.json"));
      assert.throws(() => executeClassify(root, "once", "once", true), /incomplete/);
      const oldEncoding = emptySource();
      fs.mkdirSync(path.join(root, "old-encoding"), { recursive: true });
      fs.writeFileSync(path.join(root, "old-encoding", "source-identity.json"), JSON.stringify({ ...oldEncoding, encodingVersion: "stage17-bson-tagged-v1" }));
      assert.throws(() => readSourceManifest(path.join(root, "old-encoding", "source-identity.json")), /stage17-bson-tagged-v2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a fabricated Stage 14 target from opening a sink", () => {
    const target = verifyStage13Target({ NEON_DB_URL: POOLED, NEON_DIRECT_URL: DIRECT });
    assert.equal(isVerifiedStage13Target(target), true);
    const client = { $transaction: async () => assert.fail("transaction started") };
    assert.throws(() => createPrismaSink(client as never, { branch: "stage13-dev", endpointId: STAGE13_DEV_ENDPOINT_ID } as never));
    assert.throws(() => createPrismaSink(client as never, { kind: "rehearsal-facts", endpointId: "ep-rehearsal-test", authority: "none", origin: "live-preflight" } as never));
  });
});
