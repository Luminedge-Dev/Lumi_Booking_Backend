import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PersistenceError } from "../../src/app/database/persistence-error";
import { PrismaAuthRepository } from "../../src/app/modules/auth/auth.repository";
import { UserEmailConflictError } from "../../src/app/modules/auth/auth.types";
import type { NewUserRecord } from "../../src/app/modules/auth/auth.types";
import { assertStage13Target } from "./helpers/stage13-target";

// Test users carry ids with this 8-hex prefix and emails under this local
// prefix, so cleanup can never touch Stage 14 reconciled data.
const ID_PREFIX = "ffff5155";
const EMAIL_PREFIX = "stage15-test-auth-";
const idOf = (n: number) => `${ID_PREFIX}${n.toString(16).padStart(16, "0")}`;
const emailOf = (tag: string) => `${EMAIL_PREFIX}${tag}@example.test`;

// Stage 14 quarantined users: absent from PostgreSQL by design.
const QUARANTINED_USER_IDS = [
  "67a0a179d1064dd5f3faf3a2",
  "67f7725e2d5b29e9b79db95c",
  "6a15564887b11cf639c2df6e",
  "6a5380c0eb7c5c58f73af0b5",
];

function newUser(n: number, tag: string, overrides: Partial<NewUserRecord> = {}): NewUserRecord {
  const now = new Date("2026-10-08T01:02:03.456Z");
  return {
    _id: idOf(n),
    name: `Stage15 ${tag}`,
    email: emailOf(tag),
    password: "$2a$10$stage15testhashstage15testhashstage15testhashstage15tes",
    mock: 0,
    totalMock: 0,
    result: null,
    role: "user",
    status: "active",
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Stage 15 Auth repository (live stage13-dev)", () => {
  const repository = new PrismaAuthRepository();

  async function cleanup(): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.mockAllocation.deleteMany({ where: { userId: { startsWith: ID_PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: ID_PREFIX } } });
  }

  before(async () => {
    assertStage13Target();
    await cleanup();
  });

  after(async () => {
    await cleanup().catch(() => undefined);
    await disconnectPrisma();
  });

  it("insert then find by exact email / id; optional columns absent, never null", async () => {
    const id = await repository.insertUser(newUser(1, "basic"));
    assert.equal(id, idOf(1));

    const byEmail = await repository.findByEmail(emailOf("basic"));
    assert.ok(byEmail);
    assert.equal(byEmail._id, idOf(1));
    assert.equal(byEmail.role, "user");
    assert.equal(byEmail.status, "active");
    assert.equal(byEmail.isDeleted, false);
    assert.equal("passwordChangedAt" in byEmail, false);
    assert.equal("needPasswordChange" in byEmail, false);

    const byId = await repository.findById(idOf(1));
    assert.equal(byId?.email, emailOf("basic"));
    // Uppercase ObjectId text canonicalizes to the stored lowercase id.
    assert.equal((await repository.findById(idOf(1).toUpperCase()))?._id, idOf(1));
  });

  it("missing / malformed inputs resolve to null, never throw", async () => {
    assert.equal(await repository.findByEmail(emailOf("does-not-exist")), null);
    assert.equal(await repository.findById("not-an-object-id"), null);
    assert.equal(await repository.findById(idOf(999_999)), null);
    assert.equal(await repository.findAccountStateById(undefined), null);
    assert.equal(await repository.findAccountStateById("nope"), null);
    assert.equal(await repository.findAccountStateById(idOf(999_999)), null);
  });

  it("email match is exact-string (Mongo parity): case differences do not match", async () => {
    await repository.insertUser(newUser(2, "casesensitive"));
    assert.ok(await repository.findByEmail(emailOf("casesensitive")));
    assert.equal(await repository.findByEmail(emailOf("casesensitive").toUpperCase()), null);
  });

  it("account state projection reflects live role/status/isDeleted/passwordChangedAt", async () => {
    await repository.insertUser(newUser(3, "state", { role: "user" }));
    let state = await repository.findAccountStateById(idOf(3));
    assert.deepEqual(state, { isDeleted: false, role: "user", status: "active" });

    const changedAt = new Date("2026-10-08T05:06:07.000Z");
    await getPrismaClient().$executeRaw`UPDATE users SET role = 'admin'::"UserRole", is_deleted = true, password_changed_at = ${changedAt}::timestamptz WHERE id = ${idOf(3)}`;
    state = await repository.findAccountStateById(idOf(3));
    assert.equal(state?.role, "admin");
    assert.equal(state?.isDeleted, true);
    assert.equal((state?.passwordChangedAt as Date).toISOString(), changedAt.toISOString());
  });

  it("registration persists optional text fields and a JSON result array; null result stays SQL NULL", async () => {
    await repository.insertUser(
      newUser(4, "optional", {
        contactNo: "0123456789",
        passportNumber: "P-STAGE15",
        sex: "female",
        dateOfBirth: "1990-01-02",
        transactionId: "stage15-test-txn-optional",
        result: [{ band: 7 }, "x"],
      })
    );
    const row = await getPrismaClient().user.findUnique({ where: { id: idOf(4) } });
    assert.equal(row?.contactNo, "0123456789");
    assert.equal(row?.dateOfBirth, "1990-01-02");
    assert.deepEqual(row?.result, [{ band: 7 }, "x"]);

    await repository.insertUser(newUser(5, "nullresult"));
    const sqlNull = await getPrismaClient().$queryRaw<Array<{ is_sql_null: boolean }>>`SELECT (result IS NULL) AS is_sql_null FROM users WHERE id = ${idOf(5)}`;
    assert.equal(sqlNull[0].is_sql_null, true);
  });

  it("findByTransactionId: exact string match; null/undefined matches a user WITHOUT a transactionId; other types match nothing", async () => {
    assert.deepEqual(await repository.findByTransactionId("stage15-test-txn-optional"), { _id: idOf(4) });
    assert.equal(await repository.findByTransactionId("stage15-test-txn-nobody"), null);
    // Mongo findOne({transactionId: undefined|null}) matches null-or-missing.
    assert.ok(await repository.findByTransactionId(undefined));
    assert.ok(await repository.findByTransactionId(null));
    assert.equal(await repository.findByTransactionId(42), null);
    assert.equal(await repository.findByTransactionId({ $ne: "x" }), null);
  });

  it("duplicate exact email: second registration throws UserEmailConflictError and writes nothing", async () => {
    await repository.insertUser(newUser(6, "dup"));
    await assert.rejects(() => repository.insertUser(newUser(7, "dup")), UserEmailConflictError);
    assert.equal(await getPrismaClient().user.count({ where: { email: emailOf("dup") } }), 1);
    assert.equal(await getPrismaClient().user.findUnique({ where: { id: idOf(7) } }), null);
  });

  it("concurrent registrations of the same email: exactly one wins (advisory-lock serialization)", async () => {
    const results = await Promise.allSettled([
      repository.insertUser(newUser(8, "race")),
      repository.insertUser(newUser(9, "race")),
      repository.insertUser(newUser(10, "race")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter((r) => r.status === "rejected" && r.reason instanceof UserEmailConflictError);
    assert.equal(ok.length, 1);
    assert.equal(conflicts.length, 2);
    assert.equal(await getPrismaClient().user.count({ where: { email: emailOf("race") } }), 1);
  });

  it("case-insensitive duplicate emails are NOT merged or rejected (Stage 14 left them as-is)", async () => {
    await repository.insertUser(newUser(11, "Case"));
    await repository.insertUser(newUser(12, "case", { email: emailOf("Case").toLowerCase() }));
    const a = await repository.findByEmail(emailOf("Case"));
    const b = await repository.findByEmail(emailOf("case"));
    assert.equal(a?._id, idOf(11));
    assert.equal(b?._id, idOf(12));
    // The three real case-insensitive duplicate pairs from Stage 14 are still two rows each.
    const dupes = await getPrismaClient().$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM (
        SELECT lower(email) FROM users WHERE id NOT LIKE ${ID_PREFIX + "%"} GROUP BY lower(email) HAVING count(*) > 1
      ) d`;
    assert.equal(Number(dupes[0].n), 3);
  });

  it("password update leaves updated_at untouched and only writes the requested columns", async () => {
    await repository.insertUser(newUser(13, "pw"));
    const before = await getPrismaClient().user.findUnique({ where: { id: idOf(13) } });

    await repository.updatePasswordByUserId(idOf(13), "new-hash-1");
    let row = await getPrismaClient().user.findUnique({ where: { id: idOf(13) } });
    assert.equal(row?.password, "new-hash-1");
    assert.equal(row?.updatedAt.toISOString(), before?.updatedAt.toISOString());
    assert.equal(row?.passwordChangedAt, null);
    assert.equal(row?.needPasswordChange, null);

    const changedAt = new Date("2026-10-08T07:08:09.000Z");
    await repository.updatePasswordByUserId(idOf(13), "new-hash-2", { passwordChangedAt: changedAt, needPasswordChange: false });
    row = await getPrismaClient().user.findUnique({ where: { id: idOf(13) } });
    assert.equal(row?.password, "new-hash-2");
    assert.equal(row?.passwordChangedAt?.toISOString(), changedAt.toISOString());
    assert.equal(row?.needPasswordChange, false);
    assert.equal(row?.updatedAt.toISOString(), before?.updatedAt.toISOString());

    await repository.updatePasswordByUserId(idOf(13), "new-hash-3", { passwordChangedAt: changedAt });
    row = await getPrismaClient().user.findUnique({ where: { id: idOf(13) } });
    assert.equal(row?.password, "new-hash-3");
    assert.equal(row?.needPasswordChange, false);

    await repository.updatePasswordByUserId(idOf(13), "new-hash-4", { needPasswordChange: true });
    row = await getPrismaClient().user.findUnique({ where: { id: idOf(13) } });
    assert.equal(row?.needPasswordChange, true);
  });

  it("password update for a missing / malformed user is a silent no-op (Mongo updateOne matched nothing)", async () => {
    await repository.updatePasswordByUserId(idOf(999_998), "x");
    await repository.updatePasswordByUserId("not-an-id", "x");
  });

  it("Stage 14 quarantined users are absent: no fallback, no repair", async () => {
    for (const id of QUARANTINED_USER_IDS) {
      assert.equal(await repository.findById(id), null, `quarantined ${id} must not resolve`);
      assert.equal(await repository.findAccountStateById(id), null, `quarantined ${id} must have no account state`);
    }
  });

  it("a reconciled Stage 14 user is readable through the repository", async () => {
    const sample = await getPrismaClient().user.findFirst({
      where: { id: { not: { startsWith: ID_PREFIX } }, isDeleted: false },
      orderBy: { id: "asc" },
      select: { id: true, email: true },
    });
    assert.ok(sample, "Stage 14 loaded users exist");
    const byId = await repository.findById(sample.id);
    assert.equal(byId?.email, sample.email);
    assert.ok((await repository.findByEmail(sample.email)) !== null);
  });

  it("driver/Prisma failures surface as PersistenceError without SQL or Prisma detail", async () => {
    const broken = new PrismaAuthRepository(() => {
      throw new Error("boom");
    });
    await assert.rejects(
      () => broken.findByEmail(emailOf("any")),
      (error: unknown) => !(error instanceof PersistenceError) && (error as Error).message === "boom"
    );

    const failing = new PrismaAuthRepository(
      () =>
        ({
          user: {
            findFirst: async () => {
              const error = new Error("Invalid `prisma.user.findFirst()` invocation: relation \"users\" does not exist");
              error.name = "PrismaClientKnownRequestError";
              throw Object.assign(error, { code: "P2021", clientVersion: "7" });
            },
          },
        }) as never
    );
    await assert.rejects(
      () => failing.findByEmail(emailOf("any")),
      (error: unknown) => error instanceof PersistenceError && !/prisma|relation|invocation/i.test(error.message)
    );
  });
});
