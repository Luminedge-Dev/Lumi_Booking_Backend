// Stage 15 differential parity: Auth.
//
// The SAME fixtures run through (a) the frozen pre-Stage-15 Mongo repository
// against a real ephemeral MongoDB (with the real unique-email index) and
// (b) the Stage 15 PostgreSQL repository against the real stage13-dev
// database. Differences must be declared with a reason.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaAuthRepository } from "../../src/app/modules/auth/auth.repository";
import { UserEmailConflictError } from "../../src/app/modules/auth/auth.types";
import type { NewUserRecord } from "../../src/app/modules/auth/auth.types";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { MongoAuthReference } from "./reference-mongo/auth.reference";
import { assertParity, newTestObjectId, PARITY_ID_PREFIX, toWire } from "./helpers/compare";

const created = new Date("2026-03-04T05:06:07.890Z");

type Doc = Record<string, unknown> & { _id: ObjectId };

function mongoUser(over: Record<string, unknown> = {}): Doc {
  const _id = newTestObjectId();
  return {
    _id,
    name: "Parity Auth",
    email: `stage15-parity-auth-${_id.toHexString()}@example.test`,
    password: "parity-hash",
    role: "user",
    status: "active",
    isDeleted: false,
    mock: 0,
    totalMock: 0,
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

// The AuthService reads exactly these fields from a user record. The
// PostgreSQL repository returns exactly this narrowed view; the Mongo
// reference returns the entire document. Comparing through the narrowed view is
// the contract (the extra Mongo keys were never read by the service).
const AUTH_VIEW = ["_id", "name", "email", "password", "role", "status", "isDeleted", "passwordChangedAt", "needPasswordChange"] as const;
function authView(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;
  const view: Record<string, unknown> = {};
  for (const key of AUTH_VIEW) if (record[key] !== undefined) view[key] = record[key];
  return view;
}

function newUserFor(doc: Doc): NewUserRecord {
  return {
    _id: doc._id.toHexString(),
    name: doc.name as string,
    email: doc.email as string,
    password: doc.password as string,
    mock: 0,
    totalMock: 0,
    result: (doc.result as unknown[] | undefined) ?? null,
    role: "user",
    status: "active",
    isDeleted: false,
    createdAt: created,
    updatedAt: created,
    ...(doc.contactNo !== undefined ? { contactNo: doc.contactNo as string } : {}),
    ...(doc.transactionId !== undefined ? { transactionId: doc.transactionId as string } : {}),
  };
}

describe("Stage 15 parity: Auth repository (Mongo reference vs PostgreSQL)", () => {
  let mongo: TransactionTestDb;
  let ref: MongoAuthReference;
  const pg = new PrismaAuthRepository();

  async function cleanupPg(): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.mockAllocation.deleteMany({ where: { userId: { startsWith: PARITY_ID_PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PARITY_ID_PREFIX } } });
  }

  async function loadBoth(docs: Doc[]): Promise<void> {
    await mongo.collections.usersCollection.insertMany(docs.map((d) => ({ ...d })));
    const prisma = getPrismaClient();
    for (const d of docs) {
      await prisma.user.create({
        data: {
          id: d._id.toHexString(),
          name: d.name as string,
          email: d.email as string,
          password: d.password as string,
          role: d.role as never,
          status: (d.status ?? null) as never,
          isDeleted: (d.isDeleted as boolean | undefined) ?? false,
          transactionId: (d.transactionId as string | undefined) ?? null,
          passwordChangedAt: (d.passwordChangedAt as Date | undefined) ?? null,
          needPasswordChange: (d.needPasswordChange as boolean | undefined) ?? null,
          createdAt: created,
          updatedAt: created,
        },
      });
    }
  }

  async function reset(): Promise<void> {
    await mongo.collections.usersCollection.deleteMany({});
    await cleanupPg();
  }

  before(async () => {
    assertStage13Target();
    mongo = await startTransactionTestDb();
    ref = new MongoAuthReference(mongo.collections.usersCollection);
    await cleanupPg();
  });

  after(async () => {
    await cleanupPg().catch(() => undefined);
    await disconnectPrisma();
    await mongo?.teardown();
  });

  it("findByEmail / findById found: identical through the AuthService view (incl. optional fields)", async () => {
    await reset();
    const plain = mongoUser();
    const full = mongoUser({ passwordChangedAt: new Date("2026-05-06T07:08:09.123Z"), needPasswordChange: true, contactNo: "0123" });
    await loadBoth([plain, full]);
    for (const d of [plain, full]) {
      const byEmail = { m: await ref.findByEmail(d.email as string), p: await pg.findByEmail(d.email as string) };
      assertParity(authView(byEmail.m), authView(byEmail.p as never), [], `byEmail ${d.email}`);
      const byId = { m: await ref.findById(d._id.toHexString()), p: await pg.findById(d._id.toHexString()) };
      assertParity(authView(byId.m), authView(byId.p as never), [], `byId ${d._id}`);
    }
  });

  it("legacy user missing isDeleted: only the declared default differs", async () => {
    await reset();
    const legacy = mongoUser();
    delete (legacy as Record<string, unknown>).isDeleted;
    await loadBoth([legacy]);
    assertParity(authView(await ref.findById(legacy._id.toHexString())), authView((await pg.findById(legacy._id.toHexString())) as never), [
      { path: "isDeleted", mongo: undefined, postgres: false, reason: "NOT NULL DEFAULT false column; the service treats a missing flag as not deleted" },
    ], "legacy isDeleted");
  });

  it("missing / malformed: both null (email match is exact-string on both)", async () => {
    await reset();
    const u = mongoUser({ email: "Stage15-Parity-Case@example.test" });
    await loadBoth([u]);
    for (const email of ["stage15-parity-case@example.test", "nobody-stage15@example.test", ""]) {
      assert.equal(await ref.findByEmail(email), null, email);
      assert.equal(await pg.findByEmail(email), null, email);
    }
    for (const id of ["not-an-id", "", newTestObjectId().toHexString()]) {
      assert.equal(await ref.findById(id), null);
      assert.equal(await pg.findById(id), null);
      assert.equal(await ref.findAccountStateById(id), null);
      assert.equal(await pg.findAccountStateById(id), null);
    }
    assert.equal(await ref.findAccountStateById(undefined), null);
    assert.equal(await pg.findAccountStateById(undefined), null);
  });

  it("account state: same live role/status/isDeleted/passwordChangedAt; Mongo's extra _id is the only declared difference", async () => {
    await reset();
    const changed = mongoUser({ role: "admin", isDeleted: true, passwordChangedAt: new Date("2026-05-06T07:08:09.123Z") });
    await loadBoth([changed]);
    const id = changed._id.toHexString();
    assertParity(await ref.findAccountStateById(id), await pg.findAccountStateById(id), [
      { path: "_id", mongo: id, postgres: undefined, reason: "projection always returned _id in Mongo; no consumer reads it (checkAccountState uses isDeleted/status/role/passwordChangedAt only)" },
    ], "account state");
  });

  it("duplicate case-insensitive emails: both resolve each exact email to its own row (no merge)", async () => {
    await reset();
    const a = mongoUser({ email: "stage15-parity-dup@example.test" });
    const b = mongoUser({ email: "Stage15-Parity-Dup@example.test" });
    await loadBoth([a, b]);
    assert.equal(String((await ref.findByEmail(a.email as string))?._id), a._id.toHexString());
    assert.equal((await pg.findByEmail(a.email as string))?._id, a._id.toHexString());
    assert.equal(String((await ref.findByEmail(b.email as string))?._id), b._id.toHexString());
    assert.equal((await pg.findByEmail(b.email as string))?._id, b._id.toHexString());
  });

  it("findByTransactionId: exact string, null/undefined => user without one, other types => nothing", async () => {
    await reset();
    const withTxn = mongoUser({ transactionId: "PARITY-TXN-A" });
    const without = mongoUser();
    await loadBoth([withTxn, without]);
    assert.equal(String((await ref.findByTransactionId("PARITY-TXN-A"))?._id), withTxn._id.toHexString());
    assert.equal((await pg.findByTransactionId("PARITY-TXN-A"))?._id, withTxn._id.toHexString());
    assert.equal(await ref.findByTransactionId("PARITY-TXN-NOBODY"), null);
    assert.equal(await pg.findByTransactionId("PARITY-TXN-NOBODY"), null);
    // Null/undefined matches users with no transactionId in both stores.
    // (PostgreSQL also contains real Stage 14 users, so only the match/no-match outcome is comparable.)
    for (const v of [undefined, null]) {
      assert.notEqual(await ref.findByTransactionId(v), null);
      assert.notEqual(await pg.findByTransactionId(v), null);
    }
    for (const v of [42, true]) {
      assert.equal(await ref.findByTransactionId(v), null);
      assert.equal(await pg.findByTransactionId(v), null);
    }
    // EXPECTED INTENTIONAL (Stage 15, security): the Mongo reference lets an
    // operator object ({$ne: ...}) through as a query operator (NoSQL operator
    // injection shape); PostgreSQL treats any non-string as "matches nothing".
    // Registration now also rejects non-text transactionId before this point.
    assert.notEqual(await ref.findByTransactionId({ $ne: "x" }), null);
    assert.equal(await pg.findByTransactionId({ $ne: "x" }), null);
  });

  it("insert: same persisted shape; duplicate exact email is a conflict in both; case-variants are allowed in both", async () => {
    await reset();
    const first = mongoUser({ contactNo: "0123", transactionId: "PARITY-TXN-INS" });
    const mongoId = await ref.insertUser({
      ...first,
      result: null,
    });
    assert.equal(mongoId.toHexString(), first._id.toHexString());
    await pg.insertUser(newUserFor(first));
    assertParity(
      authView(await ref.findById(first._id.toHexString())),
      authView((await pg.findById(first._id.toHexString())) as never),
      [],
      "inserted user"
    );

    const dup = mongoUser({ email: first.email });
    await assert.rejects(() => ref.insertUser({ ...dup }), (e: unknown) => (e as { code?: number }).code === 11000);
    await assert.rejects(() => pg.insertUser(newUserFor(dup)), UserEmailConflictError);

    const variant = mongoUser({ email: (first.email as string).toUpperCase() });
    await ref.insertUser({ ...variant });
    await pg.insertUser(newUserFor(variant));
    assert.equal(String((await ref.findByEmail(variant.email as string))?._id), variant._id.toHexString());
    assert.equal((await pg.findByEmail(variant.email as string))?._id, variant._id.toHexString());
  });

  it("password update: same columns change (password [+ passwordChangedAt/needPasswordChange]); missing user is a no-op in both", async () => {
    await reset();
    const user = mongoUser();
    await loadBoth([user]);
    const id = user._id.toHexString();
    const changedAt = new Date("2026-07-08T09:10:11.121Z");

    const steps: Array<{ hash: string; extra?: { passwordChangedAt?: Date; needPasswordChange?: boolean } }> = [
      { hash: "h1" },
      { hash: "h2", extra: { passwordChangedAt: changedAt, needPasswordChange: false } },
      { hash: "h3", extra: { needPasswordChange: true } },
      { hash: "h4", extra: { passwordChangedAt: changedAt } },
    ];
    for (const step of steps) {
      await ref.updatePasswordByUserId(user._id, step.hash, step.extra ?? {});
      await pg.updatePasswordByUserId(id, step.hash, step.extra ?? {});
      assertParity(authView(await ref.findById(id)), authView((await pg.findById(id)) as never), [], `after ${step.hash}`);
    }

    const ghost = newTestObjectId();
    await ref.updatePasswordByUserId(ghost, "x");
    await pg.updatePasswordByUserId(ghost.toHexString(), "x");
    assert.equal(await ref.findById(ghost.toHexString()), null);
    assert.equal(await pg.findById(ghost.toHexString()), null);
    // toWire is the shared comparison domain; keep import exercised for readers.
    assert.equal(toWire(undefined), undefined);
  });
});
