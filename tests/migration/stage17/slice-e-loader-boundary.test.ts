import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAGE13_DEV_ENDPOINT_ID, StopError, isVerifiedStage13Target, verifyStage13Target } from "../../../scripts/migration/stage14/guards";
import { createPrismaSink } from "../../../scripts/migration/stage14/load/loader";
import type { CommitBatch } from "../../../scripts/migration/stage14/load/sink";
import { verifyRehearsalTarget, type ApprovedRehearsalIdentity } from "../../../scripts/migration/stage17/rehearsal-guard";

const POOLED = `postgresql://user:secret@${STAGE13_DEV_ENDPOINT_ID}-pooler.c-2.us-east-1.aws.neon.tech/neondb`;
const DIRECT = `postgresql://user:secret@${STAGE13_DEV_ENDPOINT_ID}.c-2.us-east-1.aws.neon.tech/neondb`;

function stage13Target() {
  return verifyStage13Target({ NEON_DB_URL: POOLED, NEON_DIRECT_URL: DIRECT });
}

function rehearsalFacts() {
  const approved: ApprovedRehearsalIdentity = {
    projectId: "proj-test",
    parentBranchId: "br-parent",
    parentBranchName: "stage13-dev",
    childBranchName: "stage17-rehearsal-test",
    endpointId: "ep-rehearsal-test",
  };
  return verifyRehearsalTarget({
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
  });
}

function probe(sessionCount = 0) {
  const calls: string[] = [];
  let transactions = 0;
  const table = (name: string) => ({
    count: async () => 0,
    deleteMany: async () => {
      calls.push(`delete ${name}`);
    },
    createMany: async (args: { data: unknown[] }) => {
      calls.push(`insert ${name}:${args.data.length}`);
    },
  });
  const prisma = {
    $transaction: async (fn: (tx: object) => Promise<void>) => {
      transactions += 1;
      await fn({
        session: { count: async () => sessionCount },
        account: { count: async () => 0 },
        user: table("users"),
        course: table("courses"),
        schedule: table("schedules"),
        scheduleSlot: table("schedule_slots"),
        slotCounter: table("slot_counters"),
        mockAllocation: table("mock_allocations"),
        booking: table("bookings"),
        teacherAssignment: table("teacher_assignments"),
        feedbackEntry: table("feedback_entries"),
        feedbackStatus: table("feedback_status"),
        adminSection: table("admin_sections"),
        trfEmail: table("trf_emails"),
        trfEmailHistory: table("trf_email_history"),
      });
    },
  };
  return {
    prisma,
    calls,
    transactions: () => transactions,
  };
}

function refused(target: unknown, client = probe()): void {
  assert.throws(() => createPrismaSink(client.prisma as never, target as never), StopError);
  assert.equal(client.transactions(), 0);
  assert.deepEqual(client.calls, []);
}

describe("Stage 17 Slice E loader boundary", () => {
  it("accepts a target minted by verifyStage13Target and keeps replace-then-insert", async () => {
    const target = stage13Target();
    assert.equal(isVerifiedStage13Target(target), true);
    const client = probe();
    const sink = createPrismaSink(client.prisma as never, target);
    const batch: CommitBatch = {
      entity: "courses",
      rootIds: ["course-1"],
      rows: { courses: [{ id: "course-1" }] },
      token: { bracket: "string", last: "course-1" },
    };
    await sink.commit(batch);
    assert.deepEqual(client.calls, ["delete courses", "insert courses:1"]);

    const users = probe();
    const userSink = createPrismaSink(users.prisma as never, target);
    await userSink.commit({
      entity: "users",
      rootIds: ["user-1"],
      rows: { users: [{ id: "user-1" }] },
      token: { bracket: "string", last: "user-1" },
    });
    assert.deepEqual(users.calls, [
      "delete mock_allocations",
      "delete teacher_assignments",
      "delete feedback_entries",
      "delete feedback_status",
      "delete admin_sections",
      "delete trf_emails",
      "delete trf_email_history",
      "delete users",
      "insert users:1",
    ]);

    const blocked = probe(1);
    const blockedSink = createPrismaSink(blocked.prisma as never, target);
    await assert.rejects(
      () => blockedSink.commit({ entity: "users", rootIds: ["user-1"], rows: { users: [{ id: "user-1" }] }, token: { bracket: "string", last: "user-1" } }),
      /Better Auth rows exist/
    );
    assert.deepEqual(blocked.calls, []);
  });

  it("rejects a fabricated Stage 14 target and does not create a sink", () => {
    const minted = stage13Target();
    const copy = { branch: minted.branch, endpointId: minted.endpointId };
    assert.equal(isVerifiedStage13Target(copy), false);
    refused(copy);
    refused({ branch: "stage13-dev", endpointId: STAGE13_DEV_ENDPOINT_ID });
  });

  it("rejects rehearsal facts and a live-preflight label", () => {
    const facts = rehearsalFacts();
    assert.equal(facts.authority, "none");
    refused(facts);
    refused({ ...facts, origin: "live-preflight", authority: "live" });
    refused({ kind: "rehearsal-facts", endpointId: "ep-rehearsal-test", authority: "none", origin: "live-preflight" });
  });

  it("fails closed for missing, malformed, parent, and production targets", () => {
    refused(undefined);
    refused(null);
    refused({});
    refused({ branch: "stage13-dev" });
    refused({ endpointId: STAGE13_DEV_ENDPOINT_ID });
    refused({ branch: "stage13-dev", endpointId: "ep-falling-brook-a1b2c3d4" });
    refused({ branch: "stage17-rehearsal", endpointId: "ep-rehearsal-test", origin: "live-preflight" });
    assert.throws(() => verifyStage13Target({ NEON_DB_URL: POOLED.replace(STAGE13_DEV_ENDPOINT_ID, "ep-falling-brook-a1b2c3d4"), NEON_DIRECT_URL: DIRECT.replace(STAGE13_DEV_ENDPOINT_ID, "ep-falling-brook-a1b2c3d4") }), /production endpoint/);
    assert.throws(() => verifyStage13Target({}), /both required/);
    assert.throws(() => verifyStage13Target({ NEON_DB_URL: "not a url", NEON_DIRECT_URL: DIRECT }), /malformed/);
  });
});
