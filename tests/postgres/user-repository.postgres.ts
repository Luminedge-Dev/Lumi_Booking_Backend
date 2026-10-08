import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PersistenceError } from "../../src/app/database/persistence-error";
import { PrismaUserRepository } from "../../src/app/modules/user/user.repository";
import { assertStage13Target } from "./helpers/stage13-target";

const ID_PREFIX = "ffff5155";
const EMAIL_PREFIX = "stage15-test-user-";
const idOf = (n: number) => `${ID_PREFIX}${(0x1000 + n).toString(16).padStart(16, "0")}`;

const QUARANTINED_USER_IDS = [
  "67a0a179d1064dd5f3faf3a2",
  "67f7725e2d5b29e9b79db95c",
  "6a15564887b11cf639c2df6e",
  "6a5380c0eb7c5c58f73af0b5",
];

describe("Stage 15 User repository (live stage13-dev)", () => {
  const repository = new PrismaUserRepository();

  async function cleanup(): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.mockAllocation.deleteMany({ where: { userId: { startsWith: ID_PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: ID_PREFIX } } });
  }

  async function seedUser(n: number, extra: Record<string, unknown> = {}): Promise<string> {
    const id = idOf(n);
    await getPrismaClient().user.create({
      data: {
        id,
        name: `Stage15 User ${n}`,
        email: `${EMAIL_PREFIX}${n}@example.test`,
        password: "stage15-test-hash",
        role: "user",
        status: "active",
        createdAt: new Date("2026-03-04T05:06:07.890Z"),
        updatedAt: new Date("2026-03-04T05:06:07.890Z"),
        ...extra,
      },
    });
    return id;
  }

  before(async () => {
    assertStage13Target();
    await cleanup();
  });

  after(async () => {
    await cleanup().catch(() => undefined);
    await disconnectPrisma();
  });

  it("status: full record, nullable columns absent, password/Better-Auth columns never exposed, dates as Date", async () => {
    const id = await seedUser(1, { contactNo: "0123", dateOfBirth: "1990-05-06", budget: { cap: 5 } });
    const record = (await repository.findStatusById(id)) as Record<string, unknown>;
    assert.equal(record._id, id);
    assert.equal(record.email, `${EMAIL_PREFIX}1@example.test`);
    assert.equal(record.role, "user");
    assert.equal(record.status, "active");
    assert.equal(record.isDeleted, false);
    assert.equal(record.mock, 0);
    assert.equal(record.totalMock, 0);
    assert.equal(record.contactNo, "0123");
    assert.equal(record.dateOfBirth, "1990-05-06");
    assert.deepEqual(record.budget, { cap: 5 });
    assert.equal((record.createdAt as Date).toISOString(), "2026-03-04T05:06:07.890Z");
    for (const absent of ["password", "emailVerified", "image", "passportNumber", "sex", "result", "transactionId", "mocks", "teacherLEmail"]) {
      assert.equal(absent in record, false, `${absent} must be absent`);
    }
  });

  it("missing, malformed and null-ish ids resolve to null, never throw", async () => {
    for (const bad of ["not-an-id", "", idOf(999_999)]) {
      assert.equal(await repository.findStatusById(bad), null);
      assert.equal(await repository.findProfileById(bad), null);
      assert.equal(await repository.findSummaryById(bad), null);
    }
    assert.deepEqual(await repository.submitProfileEditRequest("not-an-id", "x"), { modifiedCount: 0 });
    assert.deepEqual(await repository.submitProfileEditRequest(idOf(999_999), "x"), { modifiedCount: 0 });
  });

  it("profile: narrow projection with only present optional columns", async () => {
    const id = await seedUser(2, { contactNo: "0999", passportNumber: "P-2", transactionId: "stage15-test-txn-2" });
    const profile = (await repository.findProfileById(id)) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(profile).sort(), ["_id", "contactNo", "createdAt", "email", "name", "passportNumber", "transactionId"]);
    assert.equal(profile.passportNumber, "P-2");

    const bare = (await repository.findProfileById(await seedUser(3))) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(bare).sort(), ["_id", "createdAt", "email", "name"]);
  });

  it("summary: mocks[] built from mock_allocations in chronological order; absent when none", async () => {
    const id = await seedUser(4);
    const none = await repository.findSummaryById(id);
    assert.equal("mocks" in (none as object), false);

    const prisma = getPrismaClient();
    await prisma.mockAllocation.createMany({
      data: [
        { userId: id, transactionId: "stage15-test-mock-late", mock: 2, createdAt: new Date("2026-02-01T00:00:00.000Z") },
        { userId: id, transactionId: "stage15-test-mock-early", mock: 1, mockType: "Home", createdAt: new Date("2026-01-01T00:00:00.000Z") },
        { userId: id, transactionId: "stage15-test-mock-null-ts", mock: 0 },
      ],
    });
    const summary = await repository.findSummaryById(id);
    assert.deepEqual(
      summary?.mocks?.map((m) => m.transactionId),
      ["stage15-test-mock-null-ts", "stage15-test-mock-early", "stage15-test-mock-late"]
    );
    // Null columns omitted on the entry itself.
    assert.deepEqual(Object.keys(summary!.mocks![0]).sort(), ["mock", "transactionId"]);
    assert.equal(summary!.mocks![1].mockType, "Home");
  });

  it("profile-edit: modifiedCount semantics match Mongo ($set no-op reports 0) and updated_at is untouched", async () => {
    const id = await seedUser(5);
    const before = await getPrismaClient().user.findUnique({ where: { id } });

    assert.deepEqual(await repository.submitProfileEditRequest(id, "please fix my name"), { modifiedCount: 1 });
    // Same status + same note => matched but nothing modified.
    assert.deepEqual(await repository.submitProfileEditRequest(id, "please fix my name"), { modifiedCount: 0 });
    // Same status + different note => modified.
    assert.deepEqual(await repository.submitProfileEditRequest(id, "another note"), { modifiedCount: 1 });
    // Empty-string note (legacy `note || ""`) is storable.
    assert.deepEqual(await repository.submitProfileEditRequest(id, ""), { modifiedCount: 1 });

    const row = await getPrismaClient().user.findUnique({ where: { id } });
    assert.equal(row?.profileChangeRequestStatus, "requested");
    assert.equal(row?.profileEditNote, "");
    assert.equal(row?.updatedAt.toISOString(), before?.updatedAt.toISOString());
  });

  it("profile-edit list: only status=requested users, id ASC, sparse columns omitted", async () => {
    const a = await seedUser(6, { profileChangeRequestStatus: "requested", profileEditNote: "note-6" });
    const b = await seedUser(7, { profileChangeRequestStatus: "approved", profileEditNote: "note-7" });
    const list = await repository.findProfileEditRequests();
    const ours = list.filter((r) => r._id.startsWith(ID_PREFIX));
    assert.ok(ours.some((r) => r._id === a));
    assert.ok(!ours.some((r) => r._id === b));
    const ids = list.map((r) => r._id);
    assert.deepEqual(ids, [...ids].sort());
    const row = ours.find((r) => r._id === a) as unknown as Record<string, unknown>;
    assert.equal(row.profileEditNote, "note-6");
    assert.equal("contactNo" in row, false);
    assert.equal("password" in row, false);
  });

  it("Stage 14 quarantined users are absent: status {user:null} inputs, profile/summary null, no fallback", async () => {
    for (const id of QUARANTINED_USER_IDS) {
      assert.equal(await repository.findStatusById(id), null, id);
      assert.equal(await repository.findProfileById(id), null, id);
      assert.equal(await repository.findSummaryById(id), null, id);
      assert.deepEqual(await repository.submitProfileEditRequest(id, "x"), { modifiedCount: 0 });
    }
  });

  it("reads a real Stage 14 user that has mock allocations", async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM mock_allocations WHERE user_id NOT LIKE ${ID_PREFIX + "%"} GROUP BY user_id ORDER BY user_id LIMIT 1`;
    assert.equal(rows.length, 1, "Stage 14 loaded mock allocations");
    const summary = await repository.findSummaryById(rows[0].user_id);
    assert.ok(summary);
    assert.ok((summary.mocks?.length ?? 0) >= 1);
    assert.equal("password" in (summary as object), false);
  });

  it("driver/Prisma failures surface as PersistenceError without SQL or Prisma detail", async () => {
    const failing = new PrismaUserRepository(
      () =>
        ({
          user: {
            findUnique: async () => {
              const error = new Error('Invalid `prisma.user.findUnique()` invocation: relation "users" does not exist');
              error.name = "PrismaClientKnownRequestError";
              throw Object.assign(error, { code: "P2021", clientVersion: "7" });
            },
          },
        }) as never
    );
    await assert.rejects(
      () => failing.findStatusById(idOf(1)),
      (error: unknown) => error instanceof PersistenceError && !/prisma|relation|invocation/i.test(error.message)
    );
  });
});
