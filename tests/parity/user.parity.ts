// Stage 15 differential parity: User.
//
// The SAME fixtures run through (a) the frozen pre-Stage-15 Mongo repository
// against a real ephemeral MongoDB and (b) the Stage 15 PostgreSQL repository
// against the real stage13-dev database. Differences must be declared with a
// reason (assertParity fails on any undeclared one).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaUserRepository } from "../../src/app/modules/user/user.repository";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { MongoUserReference } from "./reference-mongo/user.reference";
import { assertParity, newTestObjectId, PARITY_ID_PREFIX } from "./helpers/compare";

const created = new Date("2026-03-04T05:06:07.890Z");
const updated = new Date("2026-04-05T06:07:08.901Z");

type Doc = Record<string, unknown> & { _id: ObjectId };

function userDoc(over: Record<string, unknown> = {}): Doc {
  const _id = newTestObjectId();
  return {
    _id,
    name: "Parity User",
    email: `stage15-parity-user-${_id.toHexString()}@example.test`,
    password: "parity-hash",
    role: "user",
    status: "active",
    isDeleted: false,
    mock: 0,
    totalMock: 0,
    createdAt: created,
    updatedAt: updated,
    ...over,
  };
}

const MODELED_COLUMNS = [
  "name", "email", "createdAt", "updatedAt", "role", "status", "isDeleted", "dateOfBirth", "contactNo",
  "passportNumber", "sex", "result", "mock", "totalMock", "mockType", "testSystem", "testType",
  "profileChangeRequestStatus", "profileEditNote", "needPasswordChange", "passwordChangedAt", "transactionId",
  "teacherLEmail", "teacherREmail", "teacherWEmail", "teacherSEmail", "lastTrfEmailAt", "budget",
] as const;

describe("Stage 15 parity: User repository (Mongo reference vs PostgreSQL)", () => {
  let mongo: TransactionTestDb;
  let ref: MongoUserReference;
  const pg = new PrismaUserRepository();

  async function cleanupPg(): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.mockAllocation.deleteMany({ where: { userId: { startsWith: PARITY_ID_PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PARITY_ID_PREFIX } } });
  }

  // Loads a Mongo-shaped document into PostgreSQL the way Stage 14 would:
  // modeled scalar columns -> users, mocks[] -> mock_allocations, the rest dropped.
  async function loadBoth(docs: Doc[]): Promise<void> {
    await mongo.collections.usersCollection.insertMany(docs.map((d) => ({ ...d })));
    const prisma = getPrismaClient();
    for (const d of docs) {
      const data: Record<string, unknown> = { id: d._id.toHexString(), password: d.password };
      for (const column of MODELED_COLUMNS) {
        if (d[column] !== undefined) data[column] = d[column];
      }
      await prisma.user.create({ data: data as never });
      const mocks = (d.mocks as Array<Record<string, unknown>> | undefined) ?? [];
      if (mocks.length > 0) {
        await prisma.mockAllocation.createMany({ data: mocks.map((m) => ({ userId: d._id.toHexString(), ...m })) as never });
      }
    }
  }

  before(async () => {
    assertStage13Target();
    mongo = await startTransactionTestDb();
    ref = new MongoUserReference(mongo.collections.usersCollection);
    await cleanupPg();
  });

  after(async () => {
    await cleanupPg().catch(() => undefined);
    await disconnectPrisma();
    await mongo?.teardown();
  });

  async function reset(): Promise<void> {
    await mongo.collections.usersCollection.deleteMany({});
    await cleanupPg();
  }

  it("status/summary found: fully-populated user (all modeled columns + mocks[]) is identical, password excluded", async () => {
    await reset();
    const full = userDoc({
      dateOfBirth: "1990-05-06",
      contactNo: "0123456789",
      passportNumber: "P-PARITY",
      sex: "female",
      result: [{ band: 7.5 }, "x"],
      mock: 3,
      totalMock: 5,
      mockType: "Home",
      testSystem: "windows",
      testType: "Computer-Based",
      profileChangeRequestStatus: "requested",
      profileEditNote: "fix name",
      needPasswordChange: false,
      passwordChangedAt: new Date("2026-05-06T07:08:09.123Z"),
      transactionId: "PARITY-TXN-1",
      teacherLEmail: "l@example.test",
      teacherREmail: "r@example.test",
      teacherWEmail: "w@example.test",
      teacherSEmail: "s@example.test",
      lastTrfEmailAt: new Date("2026-06-07T08:09:10.234Z"),
      budget: { cap: 5, tags: ["a"] },
      mocks: [
        { transactionId: "M-1", mock: 1, mockType: "Home", testSystem: "windows", testType: "Computer-Based", emailReminderSent: false, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-02T00:00:00.000Z") },
        { transactionId: "M-2", mock: 2, createdAt: new Date("2026-02-01T00:00:00.000Z"), mrValidation: "ok", mrValidationExpiry: new Date("2027-02-01T00:00:00.000Z") },
      ],
    });
    await loadBoth([full]);
    const id = full._id.toHexString();
    const m = await ref.findStatusById(id);
    const p = await pg.findStatusById(id);
    assert.ok(m && p);
    assert.equal("password" in m, false);
    assert.equal("password" in p, false);
    assertParity(m, p, [], "status full");
    assertParity(await ref.findSummaryById(id), await pg.findSummaryById(id), [
      { path: "password", mongo: "parity-hash", postgres: undefined, reason: "summary reads the raw document in Mongo (no projection); the PostgreSQL repository never selects the hash out of the repository. The mapper discards it either way (toUserSummaryDto)." },
    ], "summary full");
  });

  it("minimal legacy user: only declared defaults differ (isDeleted/mock/totalMock are NOT NULL columns)", async () => {
    await reset();
    const minimal = userDoc();
    delete (minimal as Record<string, unknown>).isDeleted;
    delete (minimal as Record<string, unknown>).mock;
    delete (minimal as Record<string, unknown>).totalMock;
    await loadBoth([minimal]);
    const id = minimal._id.toHexString();
    assertParity(await ref.findStatusById(id), await pg.findStatusById(id), [
      { path: "isDeleted", mongo: undefined, postgres: false, reason: "NOT NULL DEFAULT false column (relational-model-plan: absent-with-contract-default)" },
      { path: "mock", mongo: undefined, postgres: 0, reason: "NOT NULL DEFAULT 0 column" },
      { path: "totalMock", mongo: undefined, postgres: 0, reason: "NOT NULL DEFAULT 0 column" },
    ], "status minimal");
  });

  it("legacy-only document keys (dateofbirth spelling, root mrValidation, unknown fields) are NOT carried by PostgreSQL", async () => {
    await reset();
    const legacy = userDoc({ dateofbirth: "1991-01-01", mrValidation: "root-ok", futureField: { a: 1 } });
    await loadBoth([legacy]);
    const id = legacy._id.toHexString();
    assertParity(await ref.findStatusById(id), await pg.findStatusById(id), [
      { path: "dateofbirth", mongo: "1991-01-01", postgres: undefined, reason: "legacy alias spelling has no Stage 13 column (Stage 14 folds it into date_of_birth when canonical is absent)" },
      { path: "mrValidation", mongo: "root-ok", postgres: undefined, reason: "root mock fields live in mock_allocations in PostgreSQL" },
      { path: "futureField", mongo: { a: 1 }, postgres: undefined, reason: "field has no Stage 13 column" },
    ], "status legacy-only keys");
  });

  it("missing user: both null. Malformed id: Mongo throws, PostgreSQL returns null (controllers validate ObjectId before this point)", async () => {
    await reset();
    const missing = newTestObjectId().toHexString();
    assert.equal(await ref.findStatusById(missing), null);
    assert.equal(await pg.findStatusById(missing), null);
    assert.equal(await ref.findProfileById(missing), null);
    assert.equal(await pg.findProfileById(missing), null);
    await assert.rejects(() => ref.findStatusById("not-an-id"));
    assert.equal(await pg.findStatusById("not-an-id"), null);
  });

  it("profile projection: identical key set for populated and sparse users", async () => {
    await reset();
    const populated = userDoc({ contactNo: "0777", passportNumber: "P-9", transactionId: "T-9", profileChangeRequestStatus: "requested", password: "x" });
    const sparse = userDoc();
    await loadBoth([populated, sparse]);
    for (const d of [populated, sparse]) {
      const id = d._id.toHexString();
      assertParity(await ref.findProfileById(id), await pg.findProfileById(id), [], `profile ${id}`);
    }
  });

  it("profile-edit list: same members and fields (ordered by id on both when seeded in id order)", async () => {
    await reset();
    const docs = [
      userDoc({ profileChangeRequestStatus: "requested", profileEditNote: "a", contactNo: "1" }),
      userDoc({ profileChangeRequestStatus: "approved", profileEditNote: "b" }),
      userDoc({ profileChangeRequestStatus: "requested", passportNumber: "P", transactionId: "T" }),
      userDoc(),
    ].sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()));
    await loadBoth(docs);
    const m = await ref.findProfileEditRequests();
    const p = (await pg.findProfileEditRequests()).filter((r) => r._id.startsWith(PARITY_ID_PREFIX));
    assert.equal(m.length, 2);
    assertParity(m, p, [], "profile-edit list");
  });

  it("profile-edit submit: identical modifiedCount sequence; PostgreSQL additionally rejects non-text notes upstream (400)", async () => {
    await reset();
    const user = userDoc();
    await loadBoth([user]);
    const id = user._id.toHexString();
    for (const note of ["first", "first", "second", "", ""]) {
      const m = await ref.submitProfileEditRequest(id, note);
      const p = await pg.submitProfileEditRequest(id, note);
      assert.deepEqual(p, m, `note=${JSON.stringify(note)}`);
    }
    const missing = newTestObjectId().toHexString();
    assert.deepEqual(await pg.submitProfileEditRequest(missing, "x"), await ref.submitProfileEditRequest(missing, "x"));
    assertParity(await ref.findStatusById(id), await pg.findStatusById(id), [], "after submits");
  });
});
