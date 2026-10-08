import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { PrismaUserRepository } from "../../src/app/modules/user/user.repository";
import { PrismaBookingRepository } from "../../src/app/modules/booking/booking.repository";
import { PrismaAuthRepository } from "../../src/app/modules/auth/auth.repository";
import { AuthService } from "../../src/app/modules/auth/auth.service";
import type { HomeBookingCommand } from "../../src/app/modules/booking/booking.types";
import { newObjectIdHex } from "../../src/app/shared/utils/object-id";
import { assertStage13Target } from "./helpers/stage13-target";
import { Stage16Fixtures, prefixedId, STAGE16B_PREFIX, STAGE16B_EMAIL_DOMAIN } from "./helpers/stage16-fixtures";

const report: Record<string, unknown> = {};
let counter = 20_000;
const nextId = () => prefixedId(STAGE16B_PREFIX, counter++);

describe("Stage 16B user admin mutations (live stage13-dev)", { timeout: 1_800_000 }, () => {
  assertStage13Target();
  const prisma = getPrismaClient();
  const fixtures = new Stage16Fixtures(prisma, STAGE16B_PREFIX);
  const users = new PrismaUserRepository();
  const bookings = new PrismaBookingRepository();
  const auth = new PrismaAuthRepository();
  const authService = new AuthService(auth, {
    jwtSecret: "stage16b-test-secret",
    jwtResetPasswordSecret: "stage16b-reset-secret",
    jwtExpiresIn: "7d",
    jwtResetPasswordTokenExpiresIn: "15m",
    resetPasswordLink: "https://example.test/reset-password",
    isProduction: false,
  });

  after(async () => {
    try {
      report.cleanupRemoved = await fixtures.cleanup();
      await fixtures.assertNamespaceEmpty("after cleanup");
      report.namespaceEmptyAfterCleanup = true;
    } finally {
      console.log("STAGE16B_REPORT " + JSON.stringify(report));
      await disconnectPrisma();
    }
  });

  async function createUser(extra: Record<string, unknown> = {}): Promise<string> {
    const id = fixtures.trackUser(nextId());
    await prisma.user.create({
      data: {
        id,
        name: "stage16b-user",
        email: `${id}@${STAGE16B_EMAIL_DOMAIN}`,
        password: "x",
        role: "user",
        mock: 0,
        totalMock: 0,
        status: "active",
        ...extra,
      },
    });
    return id;
  }

  const mockOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).mock;
  const home = (userId: string, bookingDate: string): HomeBookingCommand => ({
    bookingId: fixtures.trackBooking(nextId()),
    userId,
    name: "IELTS",
    testType: "Computer-Based",
    testSystem: "Computer-Based",
    bookingDate,
    testTime: "10:30",
    entitlement: null,
  });

  it("fixture namespace is empty before the run", async () => {
    await fixtures.assertNamespaceEmpty("before run");
  });

  it("grant persists contracted fields only, skips exact duplicate transactionIds, overflows int4", async () => {
    const id = await createUser({ mock: 1, totalMock: 1 });
    const granted = await users.grantMocks(id, [
      {
        transactionId: "MR-KEEP",
        mock: 2,
        mockType: "IELTS",
        testType: "Computer-Based",
        createdAt: new Date("2031-01-01T00:00:00.000Z"),
      },
    ]);
    assert.equal(granted.kind, "granted");
    assert.equal(await mockOf(id), 3);
    const row = await prisma.mockAllocation.findFirstOrThrow({ where: { userId: id } });
    assert.equal(row.transactionId, "MR-KEEP");
    assert.equal(row.mock, 2);

    const dup = await users.grantMocks(id, [
      { transactionId: "MR-KEEP", mock: 9, createdAt: new Date() },
    ]);
    assert.equal(dup.kind, "all_duplicates");
    assert.equal(await mockOf(id), 3);

    const nearMax = await createUser({ mock: 2147483647, totalMock: 2147483647 });
    const overflow = await users.grantMocks(nearMax, [{ transactionId: "MR-OVF", mock: 1, createdAt: new Date() }]);
    assert.equal(overflow.kind, "overflow");
    assert.equal(await mockOf(nearMax), 2147483647);
    assert.equal(await prisma.mockAllocation.count({ where: { userId: nearMax } }), 0);
  });

  it("D9: two allocations that trim to the same transaction ID refuse with ambiguous and mutate nothing", async () => {
    const id = await createUser({ mock: 4, totalMock: 4 });
    await prisma.mockAllocation.createMany({
      data: [
        { userId: id, transactionId: "MR-1", mock: 2 },
        { userId: id, transactionId: " MR-1 ", mock: 2 },
      ],
    });
    const outcome = await users.adjustMock(id, "MR-1", { mock: 1, mrValidation: "1 day" }, 1);
    assert.equal(outcome.kind, "ambiguous");
    assert.equal(await mockOf(id), 4);
    const remaining = await prisma.mockAllocation.findMany({ where: { userId: id } });
    assert.deepEqual(
      remaining.map((row) => row.mock).sort(),
      [2, 2]
    );
  });

  it("P1: mixed-case collision is 409 with no mutation; same account email is allowed", async () => {
    const owner = await createUser({ email: `Member@${STAGE16B_EMAIL_DOMAIN}`, name: "Owner" });
    const target = await createUser({
      email: `other.${nextId()}@${STAGE16B_EMAIL_DOMAIN}`,
      name: "Target",
      profileEditNote: "please",
      profileChangeRequestStatus: "requested",
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target } });
    const clash = await users.approveProfileEdit(target, { email: `member@${STAGE16B_EMAIL_DOMAIN}`, name: "Hacked" });
    assert.equal(clash.kind, "email_in_use");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target } });
    assert.equal(after.email, before.email);
    assert.equal(after.name, "Target");
    assert.equal(after.profileEditNote, "please");
    assert.equal(after.profileChangeRequestStatus, "requested");
    assert.equal(after.updatedAt.toISOString(), before.updatedAt.toISOString());

    const same = await users.approveProfileEdit(owner, { email: `Member@${STAGE16B_EMAIL_DOMAIN}` });
    assert.equal(same.kind, "updated");
    const folded = await prisma.user.findUniqueOrThrow({ where: { id: owner } });
    assert.equal(folded.email, `member@${STAGE16B_EMAIL_DOMAIN}`);
  });

  it("P1 concurrent two-admin assign of the same email: one updated, one email_in_use, one owner", async () => {
    const shared = `shared.${nextId()}@${STAGE16B_EMAIL_DOMAIN}`;
    const a = await createUser({ name: "A" });
    const b = await createUser({ name: "B" });
    const outcomes = await Promise.all([
      users.approveProfileEdit(a, { email: shared }),
      users.approveProfileEdit(b, { email: shared.toUpperCase() }),
    ]);
    const kinds = outcomes.map((o) => o.kind).sort();
    assert.deepEqual(kinds, ["email_in_use", "updated"]);
    const emails = [
      (await prisma.user.findUniqueOrThrow({ where: { id: a } })).email,
      (await prisma.user.findUniqueOrThrow({ where: { id: b } })).email,
    ];
    assert.equal(emails.filter((e) => e === shared).length, 1);
    report.concurrentApprove = kinds;
  });

  it("login / forgot-password resolve the approved lowercase email and not the old one", async () => {
    const password = "Stage16b!pass";
    const hash = await bcrypt.hash(password, 10);
    const id = await createUser({ password: hash, name: "Login" });
    const oldEmail = `${id}@${STAGE16B_EMAIL_DOMAIN}`;
    const nextEmail = `renamed.${id}@${STAGE16B_EMAIL_DOMAIN}`;
    const approved = await users.approveProfileEdit(id, { email: nextEmail });
    assert.equal(approved.kind, "updated");
    assert.equal((await auth.findByEmail(oldEmail))?._id, undefined);
    assert.equal((await auth.findByEmail(nextEmail))?._id, id);
    const login = await authService.login({ email: nextEmail, password });
    assert.equal(login.userId, id);
    const forgot = await authService.prepareForgotPassword({ email: nextEmail });
    assert.equal(forgot.found, true);
    const forgotOld = await authService.prepareForgotPassword({ email: oldEmail });
    assert.equal(forgotOld.found, false);
  });

  it("isDeleted and status=blocked are independently visible to auth account state", async () => {
    const id = await createUser({ status: "active", isDeleted: false });
    const live = async () => auth.findAccountStateById(id);
    assert.equal((await live())?.isDeleted, false);
    assert.equal((await live())?.status, "active");

    await users.updateStatus(id, "blocked");
    assert.equal((await live())?.status, "blocked");
    await users.updateStatus(id, "active");
    await users.updateBlock(id, true);
    assert.equal((await live())?.isDeleted, true);
    assert.equal((await live())?.status, "active");
    await users.updateStatus(id, "checked");
    assert.equal((await live())?.isDeleted, true);
    assert.equal((await live())?.status, "checked");
    await users.updateBlock(id, false);
    assert.equal((await live())?.isDeleted, false);
    assert.equal((await live())?.status, "checked");
  });

  it("grant vs Home book: credit conserved; grant rollback leaves booking-only mutation", async () => {
    const id = await createUser({ mock: 1, totalMock: 1 });
    const [grantOutcome, bookOutcome] = await Promise.all([
      users.grantMocks(id, [{ transactionId: "MR-RACE", mock: 2, createdAt: new Date() }]),
      bookings.createHomeBooking(home(id, "2031-08-01")),
    ]);
    assert.equal(grantOutcome.kind, "granted");
    assert.ok(bookOutcome.kind === "booked" || bookOutcome.kind === "insufficient_credit");
    const mock = await mockOf(id);
    const bookingCount = await prisma.booking.count({ where: { userId: id } });
    assert.equal(mock + bookingCount, 3, JSON.stringify({ mock, bookingCount, book: bookOutcome.kind }));
    report.grantVsBook = { grant: grantOutcome.kind, book: bookOutcome.kind, mock, bookingCount };

    const rollbackUser = await createUser({ mock: 2, totalMock: 2 });
    const faulty = new PrismaUserRepository(undefined, undefined, (point) => {
      if (point === "grant.after_insert") throw new Error("injected grant failure");
    });
    const [rolled, booked] = await Promise.allSettled([
      faulty.grantMocks(rollbackUser, [{ transactionId: "MR-FAIL", mock: 5, createdAt: new Date() }]),
      bookings.createHomeBooking(home(rollbackUser, "2031-08-02")),
    ]);
    assert.equal(rolled.status, "rejected");
    assert.equal(booked.status, "fulfilled");
    assert.equal(await prisma.mockAllocation.count({ where: { userId: rollbackUser } }), 0);
    assert.equal(await mockOf(rollbackUser) + (await prisma.booking.count({ where: { userId: rollbackUser } })), 2);
  });

  it("adjust vs cancel: no lost update; credit + bookings conserved", async () => {
    const id = await createUser({ mock: 1, totalMock: 1 });
    await prisma.mockAllocation.create({ data: { userId: id, transactionId: "MR-ADJ", mock: 1 } });
    const booked = await bookings.createHomeBooking(home(id, "2031-09-01"));
    assert.equal(booked.kind, "booked");
    const bookingId = booked.kind === "booked" ? booked.booking._id : "";
    const [adjusted, cancelled] = await Promise.all([
      users.adjustMock(id, "MR-ADJ", { mock: 4, mrValidation: "1 day" }, 4),
      bookings.cancelBooking({ bookingId, actorUserId: id, actorIsAdmin: false }),
    ]);
    assert.equal(adjusted.kind, "updated");
    assert.equal(cancelled.kind, "cancelled");
    // start 1, Home book -1, adjust 1→4 (+3), cancel +1 → 4. Never 3 (lost cancel) or 1 (lost adjust).
    assert.equal(await mockOf(id), 4);
    assert.equal(await prisma.booking.count({ where: { userId: id } }), 0);
    report.adjustVsCancel = { mock: await mockOf(id) };
  });

  it("residual: register exact-match still allows a lowercase twin of mixed-case legacy email", async () => {
    const mixed = `LegacyMix.${nextId()}@${STAGE16B_EMAIL_DOMAIN}`;
    await createUser({ email: mixed });
    const twinId = fixtures.trackUser(nextId());
    await auth.insertUser({
      _id: twinId,
      name: "twin",
      email: mixed.toLowerCase(),
      password: "x",
      role: "user",
      status: "active",
      isDeleted: false,
      mock: 0,
      totalMock: 0,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const twins = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE lower(email) = ${mixed.toLowerCase()} AND id LIKE ${STAGE16B_PREFIX + "%"}`;
    assert.equal(twins.length, 2);
    report.registerResidualCiDuplicate = true;
  });
});
