// Stage 16 differential parity: Booking + Home teacher assignment.
//
// The SAME HTTP requests run through (a) the real legacy runtime (app.js ->
// routes/booking.routes.js + routes/feedback.routes.js) against a real
// ephemeral MongoDB replica set and (b) the Stage 16 native module (real
// PrismaBookingRepository + PostgreSQL-backed auth) against the real
// stage13-dev database. Status, body and the resulting credit/seat/booking
// state must match, EXCEPT for the declared, reasoned differences below
// (assertParity fails on any undeclared one and on any stale declaration).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Application } from "express";
import { createApp } from "../../src/app";
import { createCoreRepositories } from "../../src/app/runtime/core-repositories";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import type { BookingNotifier } from "../../src/app/modules/booking/booking.service";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { freshLegacyTransactionApp } from "../transactions/helpers/fresh-legacy-app";
import { applyTestEnv, restoreTestEnv } from "../transactions/helpers/jwt";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { Stage16Fixtures, stage16Id, STAGE16_EMAIL_DOMAIN } from "../postgres/helpers/stage16-fixtures";
import { assertParity, type IntentionalDifference } from "./helpers/compare";

const authConfig: AuthConfig = {
  jwtSecret: "test-only-secret",
  jwtResetPasswordSecret: "test-only-reset-secret",
  jwtExpiresIn: "7d",
  jwtResetPasswordTokenExpiresIn: "15m",
  resetPasswordLink: "https://example.test/reset-password",
  isProduction: false,
};
const silentNotifier: BookingNotifier = { bookingConfirmed() {}, attendanceRecorded() {} };

type Role = "user" | "admin";
interface Actor { id: string; role: Role }
interface Wire { status: number; body: Record<string, unknown> }

let counter = 9000;
const nextId = () => stage16Id(counter++);

// Ids are world-specific for bookings, so every `_id` is masked before comparing.
function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "_id" ? "<id>" : mask(v)]));
  }
  return value;
}

describe("Stage 16 parity: booking HTTP contract (legacy Mongo runtime vs PostgreSQL native)", { timeout: 1_800_000 }, () => {
  let mongo: TransactionTestDb;
  let legacy: Application;
  let native: Application;
  let fixtures: Stage16Fixtures;

  before(async () => {
    assertStage13Target();
    applyTestEnv();
    mongo = await startTransactionTestDb();
    legacy = freshLegacyTransactionApp(mongo.collections, mongo.client);
    native = createApp(
      { ...mongo.collections, client: mongo.client },
      { corsOrigins: ["http://localhost:3000"], trustProxyHops: 1, authConfig, repositories: createCoreRepositories(), bookingNotifier: silentNotifier }
    );
    fixtures = new Stage16Fixtures(getPrismaClient());
    await fixtures.assertNamespaceEmpty("parity before");
  });

  after(async () => {
    try {
      await fixtures?.cleanup();
      await fixtures?.assertNamespaceEmpty("parity after");
    } finally {
      await disconnectPrisma();
      await mongo?.teardown();
      restoreTestEnv();
    }
  });

  const token = (actor: Actor) => jwt.sign({ userId: actor.id, email: `${actor.id}@${STAGE16_EMAIL_DOMAIN}`, role: actor.role }, "test-only-secret");

  async function seedUser(role: Role, mock: number, extra: Record<string, unknown> = {}): Promise<Actor> {
    const id = fixtures.trackUser(nextId());
    await mongo.collections.usersCollection.insertOne({
      _id: new ObjectId(id), name: "Parity User", email: `${id}@${STAGE16_EMAIL_DOMAIN}`, password: "x", role, mock, totalMock: mock, status: "active", ...extra,
    } as never);
    await getPrismaClient().user.create({
      data: { id, name: "Parity User", email: `${id}@${STAGE16_EMAIL_DOMAIN}`, password: "x", role, mock, totalMock: mock, status: "active", ...extra },
    });
    return { id, role };
  }

  async function seedSchedule(seats: number, startDate = "2031-02-03"): Promise<string> {
    const id = fixtures.trackSchedule(nextId());
    await mongo.collections.schedulesCollection.insertOne({
      _id: new ObjectId(id), courseId: stage16Id(1), startDate, endDate: startDate, name: "Parity IELTS", testSystem: "", testType: "Computer-Based",
      status: "Scheduled", timeSlots: [{ slotId: "1", slot: seats, totalSlot: seats, startTime: "09:00:00", endTime: "10:00:00" }], createdAt: new Date(),
    } as never);
    const prisma = getPrismaClient();
    await prisma.schedule.create({
      data: { id, name: "Parity IELTS", courseId: stage16Id(1), startDate: new Date(`${startDate}T00:00:00.000Z`), endDate: new Date(`${startDate}T00:00:00.000Z`), testType: "ComputerBased", status: "Scheduled", createdAt: new Date() },
    });
    await prisma.scheduleSlot.create({ data: { scheduleId: id, position: 0, slotId: "1", seatsLeft: seats, capacityTotal: seats, startTime: "09:00:00", endTime: "10:00:00" } });
    return id;
  }

  async function call(app: Application, method: "get" | "post" | "put" | "delete", path: string, actor: Actor | null, body?: unknown): Promise<Wire> {
    let req = request(app)[method](`/api/v1${path}`);
    if (actor) req = req.set("Authorization", `Bearer ${token(actor)}`);
    const res = body === undefined ? await req : await req.send(body as object);
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  // Runs one request in both worlds; `path`/`body` may depend on the world
  // (booking ids differ between worlds).
  async function both(method: "get" | "post" | "put" | "delete", path: string | ((w: "m" | "p") => string), actor: Actor | null, body?: unknown | ((w: "m" | "p") => unknown)) {
    const resolve = <T,>(v: T | ((w: "m" | "p") => T), w: "m" | "p"): T => (typeof v === "function" ? (v as (w: "m" | "p") => T)(w) : v);
    const m = await call(legacy, method, resolve(path, "m"), actor, resolve(body, "m"));
    const p = await call(native, method, resolve(path, "p"), actor, resolve(body, "p"));
    return { m, p };
  }

  async function state(userId: string, scheduleId?: string) {
    const user = await mongo.collections.usersCollection.findOne({ _id: new ObjectId(userId) });
    const mongoState: Record<string, unknown> = {
      mock: user?.mock,
      bookings: await mongo.collections.bookingMockCollection.countDocuments({ userId }),
    };
    const prisma = getPrismaClient();
    const pgState: Record<string, unknown> = {
      mock: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mock,
      bookings: await prisma.booking.count({ where: { userId } }),
    };
    if (scheduleId) {
      const schedule = await mongo.collections.schedulesCollection.findOne({ _id: new ObjectId(scheduleId) });
      mongoState.seats = (schedule?.timeSlots as Array<{ slot: number }>)[0]!.slot;
      pgState.seats = (await prisma.scheduleSlot.findFirstOrThrow({ where: { scheduleId, slotId: "1" } })).seatsLeft;
    }
    return { m: mongoState, p: pgState };
  }

  const expectParity = (r: { m: Wire; p: Wire }, differences: IntentionalDifference[], label: string) =>
    assertParity({ status: r.m.status, body: mask(r.m.body) }, { status: r.p.status, body: mask(r.p.body) }, differences, label);

  const homeBody = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId, location: "Home", name: "IELTS", testType: "Computer-Based", testSystem: "Computer-Based", bookingDate: "2031-03-01", testTime: "10:30", status: "pending", ...extra,
  });
  const centerBody = (userId: string, scheduleId: string, extra: Record<string, unknown> = {}) => ({
    userId, location: "Test Center", scheduleId, slotId: "1", testType: "Computer-Based", name: "IELTS", ...extra,
  });

  it("Home booking: same body, same credit/booking state; duplicate date and zero credit reject identically", async () => {
    const u = await seedUser("user", 2);
    const ok = await both("post", "/user/book-slot", u, homeBody(u.id));
    expectParity(ok, [], "home success");
    assert.equal(ok.m.status, 200);
    assert.deepEqual((await state(u.id)).m, (await state(u.id)).p);

    const dup = await both("post", "/user/book-slot", u, homeBody(u.id));
    expectParity(dup, [], "home duplicate");
    assert.equal(dup.p.status, 400);

    await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-03-02" }));
    const none = await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-03-03" }));
    expectParity(none, [], "home zero credit");
    const s = await state(u.id);
    assert.deepEqual(s.m, s.p);
    assert.equal(s.p.mock, 0);
  });

  it("Test Center booking: same body (incl. testSystem null and schedule-owned date), same seat/credit/booking state", async () => {
    const u = await seedUser("user", 1);
    const sid = await seedSchedule(3);
    const ok = await both("post", "/user/book-slot", u, centerBody(u.id, sid));
    expectParity(ok, [], "center success");
    assert.equal(ok.p.status, 200);
    const s = await state(u.id, sid);
    assert.deepEqual(s.m, s.p);
    assert.equal(s.p.seats, 2);
    assert.equal(s.p.mock, 0);
  });

  it("validation and eligibility rejections are byte-identical", async () => {
    const u = await seedUser("user", 3);
    const other = await seedUser("user", 3);
    const sid = await seedSchedule(0);
    const cases: Array<[string, Record<string, unknown>, Actor]> = [
      ["missing userId/location", { location: "Home" }, u],
      ["bad user id", { userId: "zzz", location: "Home" }, u],
      ["forbidden for another user", homeBody(other.id), u],
      ["invalid location", { userId: u.id, location: "Mars" }, u],
      ["home without date/time", homeBody(u.id, { bookingDate: "" }), u],
      ["center missing fields", { userId: u.id, location: "Test Center" }, u],
      ["center empty testSystem", centerBody(u.id, sid, { testSystem: "  " }), u],
      ["center bad schedule id", centerBody(u.id, "nope"), u],
      ["center unknown schedule", centerBody(u.id, nextId()), u],
      ["center no seats", centerBody(u.id, sid), u],
      ["center unknown slot", centerBody(u.id, sid, { slotId: "99" }), u],
    ];
    for (const [label, body, actor] of cases) expectParity(await both("post", "/user/book-slot", actor, body), [], label);
    const s = await state(u.id);
    assert.deepEqual(s.m, s.p);
    assert.equal(s.p.mock, 3, "no rejected request consumed credit");
  });

  it("DECLARED DIFFERENCES (A1): persistence-forced 400s that legacy Mongo accepted", async () => {
    const u = await seedUser("user", 3);
    const badDate = await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-02-30" }));
    assert.equal(badDate.m.status, 200, "legacy stored any string as bookingDate");
    assert.equal(badDate.p.status, 400);
    const badType = await both("post", "/user/book-slot", u, homeBody(u.id, { testType: "Unknown", testSystem: "Computer-Based", bookingDate: "2031-03-09" }));
    assert.equal(badType.m.status, 200, "legacy stored any string as testType");
    assert.equal(badType.p.status, 400);
  });

  it("cancellation: same bodies and effects; second cancel is 404 in PostgreSQL (A2); ownership and ids reject identically", async () => {
    const u = await seedUser("user", 1);
    const stranger = await seedUser("user", 1);
    const admin = await seedUser("admin", 0);
    const sid = await seedSchedule(2);
    await both("post", "/user/book-slot", u, centerBody(u.id, sid));
    const ids = {
      m: String((await mongo.collections.bookingMockCollection.findOne({ userId: u.id }))!._id),
      p: (await getPrismaClient().booking.findFirstOrThrow({ where: { userId: u.id } })).id,
    };
    const path = (w: "m" | "p") => `/bookings/${ids[w]}`;

    expectParity(await both("delete", path, stranger), [], "cancel forbidden");
    expectParity(await both("delete", "/bookings/not-an-id", u), [], "cancel invalid id");
    expectParity(await both("delete", `/bookings/${nextId()}`, u), [], "cancel unknown id");
    let s = await state(u.id, sid);
    assert.deepEqual(s.m, s.p);
    assert.equal(s.p.seats, 1);

    const ok = await both("delete", path, admin);
    expectParity(ok, [], "cancel by admin");
    assert.equal(ok.p.status, 200);
    s = await state(u.id, sid);
    assert.deepEqual(s.m, s.p);
    assert.equal(s.p.seats, 2);
    assert.equal(s.p.mock, 1);

    const again = await both("delete", path, admin);
    assert.equal(again.m.status, 404);
    assert.equal(again.p.status, 404, "losing/duplicate cancel is 404 in both");
    expectParity(again, [], "second cancel");
  });

  it("reads: by-user list shape/ordering, admin list auth, attendance bulk", async () => {
    const u = await seedUser("user", 3);
    const admin = await seedUser("admin", 0);
    await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-04-01" }));
    await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-04-09" }));
    expectParity(await both("get", `/user/bookings/${u.id}`, u), [], "by-user list");
    expectParity(await both("get", `/user/bookings/${u.id}`, admin), [], "by-user list as admin");
    const stranger = await seedUser("user", 0);
    expectParity(await both("get", `/user/bookings/${u.id}`, stranger), [], "by-user list forbidden");
    expectParity(await both("get", "/admin/bookings?limit=1", u), [], "admin list non-admin");
    expectParity(await both("post", "/user/attendance/bulk", admin, { userIds: [u.id] }), [], "attendance bulk");
    expectParity(await both("post", "/user/attendance/bulk", admin, {}), [], "attendance bulk invalid");
  });

  it("attendance update: same bodies for unknown, updated and already-updated", async () => {
    const u = await seedUser("user", 2);
    const admin = await seedUser("admin", 0);
    await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-05-01" }));
    const upd = (extra: Record<string, unknown>) => ({ userId: u.id, attendance: "present", status: "Present", bookingDate: "2031-05-01", ...extra });
    expectParity(await both("put", "/user/bookings/home", admin, { userId: u.id }), [], "attendance missing");
    expectParity(await both("put", "/user/bookings/home", admin, upd({ bookingDate: "2031-05-02" })), [], "attendance unknown booking");
    expectParity(await both("put", "/user/bookings/home", admin, upd({})), [], "attendance updated");
    expectParity(await both("put", "/user/bookings/home", admin, upd({})), [], "attendance already updated");
    expectParity(await both("put", "/user/bookings/home", u, upd({})), [], "attendance non-admin");
    const weird = await both("put", "/user/bookings/home", admin, upd({ status: "Weird", bookingDate: "2031-05-01" }));
    assert.equal(weird.m.status, 200, "legacy accepted any status string");
    assert.equal(weird.p.status, 400, "A1: status is a closed enum in PostgreSQL");
  });

  it("Home teacher assignment: same response body and booking-side fields; non-Home and validation reject identically", async () => {
    const u = await seedUser("user", 2);
    const admin = await seedUser("admin", 0);
    const sid = await seedSchedule(2);
    await both("post", "/user/book-slot", u, homeBody(u.id, { bookingDate: "2031-06-01" }));
    await both("post", "/user/book-slot", u, centerBody(u.id, sid));
    const idOf = async (location: "Home" | "Test Center") => ({
      m: String((await mongo.collections.bookingMockCollection.findOne({ userId: u.id, location }))!._id),
      p: (await getPrismaClient().booking.findFirstOrThrow({ where: { userId: u.id, location: location === "Home" ? "Home" : "TestCenter" } })).id,
    });
    const home = await idOf("Home");
    const center = await idOf("Test Center");
    const put = (ids: { m: string; p: string }, body: Record<string, unknown>, actor: Actor = admin) =>
      both("put", (w) => `/admin/bookings/${ids[w]}/teacher`, actor, body);

    expectParity(await put(home, { skill: "L", teacher: "Ms Lee", email: "  LEE@Example.Test " }), [], "assign L");
    expectParity(await put(home, { skill: "R", teacher: "Mr Kim", email: "kim@example.test" }), [], "assign R");
    expectParity(await put(center, { skill: "L", teacher: "x", email: "x@example.test" }), [], "assign non-home");
    expectParity(await put(home, { skill: "Q", teacher: "x", email: "x@example.test" }), [], "assign bad skill");
    expectParity(await put(home, { skill: "L", teacher: "", email: "x@example.test" }), [], "assign missing teacher");
    expectParity(await put(home, { skill: "L", teacher: "x", email: "x@example.test" }, u), [], "assign non-admin");
    expectParity(await both("put", "/admin/bookings/not-an-id/teacher", admin, { skill: "L", teacher: "x", email: "e" }), [], "assign invalid id");

    // Authoritative PostgreSQL state agrees with the booking-side cache.
    const row = await getPrismaClient().teacherAssignment.findFirstOrThrow({ where: { userId: u.id } });
    const booking = await getPrismaClient().booking.findUniqueOrThrow({ where: { id: home.p } });
    assert.deepEqual([row.teacherL, row.teacherLEmail, row.teacherR, row.teacherREmail], [booking.teacherL, booking.teacherLEmail, booking.teacherR, booking.teacherREmail]);
    const mongoUser = await mongo.collections.usersCollection.findOne({ _id: new ObjectId(u.id) });
    const map = (mongoUser?.teachersBySchedule as Record<string, Record<string, string>>)[home.m]!;
    assert.deepEqual([map.teacherL, map.teacherLEmail, map.teacherR, map.teacherREmail], [row.teacherL, row.teacherLEmail, row.teacherR, row.teacherREmail]);
  });
});
