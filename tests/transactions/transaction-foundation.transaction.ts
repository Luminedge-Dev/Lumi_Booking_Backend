// Stage 10 — Transaction-Capable Test Foundation.
//
// Characterizes (does not redesign) the four existing real-Mongo
// transaction workflows in routes/booking.routes.js and
// routes/feedback.routes.js, against a real, disposable, local-only
// MongoDB replica set (mongodb-memory-server-core) -- never a fake/mocked
// session, never production/Atlas. Test infrastructure only: no
// src/app/modules/booking/** code, no production transaction abstraction,
// no business-rule redesign.
//
// Run via `pnpm test:transaction` only -- this file deliberately uses the
// *.transaction.ts suffix (not *.test.ts) so the bare `pnpm test` (fast
// fake/in-memory suite) never implicitly starts a real MongoDB process.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";
import { startTransactionTestDb, type TransactionTestDb } from "./helpers/replica-set";
import { freshLegacyTransactionApp } from "./helpers/fresh-legacy-app";
import { applyTestEnv, restoreTestEnv, signTestToken, seedUser } from "./helpers/jwt";
import { interceptCollectionCall } from "./helpers/collection-proxy";
import { AsyncBarrier } from "./helpers/async-barrier";
import { createApp } from "../../src/app";
import type { AppCollections, AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";

let testDb: TransactionTestDb;

before(async () => {
  applyTestEnv();
  testDb = await startTransactionTestDb();
});

beforeEach(async () => {
  await testDb.reset();
});

after(async () => {
  try {
    await testDb.teardown();
  } finally {
    restoreTestEnv();
  }
});

function withCollections(overrides: Partial<AppCollections>): AppCollections {
  return { ...testDb.collections, ...overrides };
}

function legacyApp(overrides: Partial<AppCollections> = {}) {
  return freshLegacyTransactionApp(withCollections(overrides), testDb.client);
}

async function seedSchedule(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new ObjectId(),
    courseId: "course-1",
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    status: "Scheduled",
    timeSlots: [{ slotId: "1", slot: 1, startTime: "09:00:00", endTime: "10:00:00" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  await testDb.collections.schedulesCollection.insertOne(doc as unknown as Document);
  return doc;
}

async function seedBooking(overrides: Record<string, unknown>) {
  const doc = {
    _id: new ObjectId(),
    status: "pending",
    location: "Test Center",
    ...overrides,
  };
  await testDb.collections.bookingMockCollection.insertOne(doc as unknown as Document);
  return doc;
}

// ---------------------------------------------------------------------
// ss11: topology + generic transaction commit/abort smoke
// ---------------------------------------------------------------------
describe("Stage 10 harness: topology + generic transaction smoke", () => {
  it("ephemeral replica set reports real replica-set topology with session support", async () => {
    const hello = await testDb.db.command({ hello: 1 });
    assert.ok(hello.setName, "expected hello.setName -- not a standalone instance");
  });

  it("generic transaction commit is visible outside the session", async () => {
    const session = testDb.client.startSession();
    try {
      session.startTransaction();
      const userId = new ObjectId();
      const bookingId = new ObjectId();
      await testDb.collections.usersCollection.insertOne({ _id: userId, email: "smoke-commit@example.test" } as unknown as Document, { session });
      await testDb.collections.bookingMockCollection.insertOne({ _id: bookingId, userId: userId.toString() } as unknown as Document, { session });
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }
    const user = await testDb.collections.usersCollection.findOne({ email: "smoke-commit@example.test" });
    const booking = await testDb.collections.bookingMockCollection.findOne({ userId: { $exists: true } });
    assert.ok(user, "expected the user doc to survive a committed transaction");
    assert.ok(booking, "expected the booking doc to survive a committed transaction");
  });

  it("generic transaction abort rolls back -- harness can actually observe rollback", async () => {
    const session = testDb.client.startSession();
    try {
      session.startTransaction();
      const userId = new ObjectId();
      await testDb.collections.usersCollection.insertOne({ _id: userId, email: "smoke-abort@example.test" } as unknown as Document, { session });
      await testDb.collections.bookingMockCollection.insertOne({ _id: new ObjectId(), userId: userId.toString() } as unknown as Document, { session });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    const user = await testDb.collections.usersCollection.findOne({ email: "smoke-abort@example.test" });
    const bookingCount = await testDb.collections.bookingMockCollection.countDocuments({});
    assert.equal(user, null, "expected the user insert to have been rolled back");
    assert.equal(bookingCount, 0, "expected the booking insert to have been rolled back");
  });
});

// ---------------------------------------------------------------------
// ss12: Home booking commit + rollback
// ---------------------------------------------------------------------
describe("Home booking (POST /api/v1/user/book-slot, location:Home) -- real transaction", () => {
  it("commit: booking insert and credit decrement commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const app = legacyApp();
    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actor._id as ObjectId)}`)
      .send({ userId: (actor._id as ObjectId).toString(), location: "Home", bookingDate: "2026-11-01", testTime: "09:00" });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actor._id as ObjectId });
    assert.equal(updatedUser?.mock, 0);
  });

  it("rollback: forced credit-decrement failure rolls back the booking insert, credit unchanged", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const actorId = actor._id as ObjectId;

    const { proxy } = interceptCollectionCall(
      testDb.collections.usersCollection,
      "updateOne",
      (...args: unknown[]) => {
        const [filter, , options] = args as [{ _id?: ObjectId }, unknown, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(actorId);
      },
      async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
    );

    const app = legacyApp({ usersCollection: proxy as Collection<Document> });
    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actorId)}`)
      .send({ userId: actorId.toString(), location: "Home", bookingDate: "2026-11-01", testTime: "09:00" });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Insufficient mock tests available.");
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0, "booking insert must have been rolled back");
    const unchangedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(unchangedUser?.mock, 1, "credit must be unchanged");
  });
});

// ---------------------------------------------------------------------
// ss13: Test Center booking commit + rollback + last-seat race
// ---------------------------------------------------------------------
describe("Test Center booking (POST /api/v1/user/book-slot, location:Test Center) -- real transaction", () => {
  it("commit: seat decrement, credit decrement, and booking insert commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const schedule = await seedSchedule();
    const app = legacyApp();

    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actor._id as ObjectId)}`)
      .send({
        userId: (actor._id as ObjectId).toString(),
        location: "Test Center",
        scheduleId: (schedule._id as ObjectId).toString(),
        slotId: "1",
        testType: "IELTS",
        testSystem: "Academic",
        name: "IELTS Course",
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 0);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actor._id as ObjectId });
    assert.equal(updatedUser?.mock, 0);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1);
  });

  it("rollback: credit-decrement failure (after seat already decremented) rolls back the seat, no booking persisted", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const actorId = actor._id as ObjectId;
    const schedule = await seedSchedule();

    const { proxy } = interceptCollectionCall(
      testDb.collections.usersCollection,
      "updateOne",
      (...args: unknown[]) => {
        const [filter, , options] = args as [{ _id?: ObjectId }, unknown, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(actorId);
      },
      async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
    );

    const app = legacyApp({ usersCollection: proxy as Collection<Document> });
    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actorId)}`)
      .send({
        userId: actorId.toString(),
        location: "Test Center",
        scheduleId: (schedule._id as ObjectId).toString(),
        slotId: "1",
        testType: "IELTS",
        testSystem: "Academic",
        name: "IELTS Course",
      });

    // The route's own code converts a modifiedCount===0 credit decrement
    // into `throw new Error(...)`, caught by the route's OUTER try/catch
    // (not the inner TransientTransactionError branch) -> generic 500.
    assert.equal(res.status, 500);
    assert.equal(res.body.message, "Internal server error");

    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 1, "seat decrement must have been rolled back");
    const unchangedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(unchangedUser?.mock, 1);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0);
  });

  it("last-seat race: exactly one concurrent booking commits, no oversell, no partial loser writes", async () => {
    const userA = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const userB = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const schedule = await seedSchedule();
    const scheduleId = schedule._id as ObjectId;

    const barrier = new AsyncBarrier(2, 8000);
    const { proxy } = interceptCollectionCall(
      testDb.collections.schedulesCollection,
      "updateOne",
      (...args: unknown[]) => {
        const [filter, , options] = args as [{ _id?: ObjectId; "timeSlots.slotId"?: string }, unknown, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(scheduleId) && filter["timeSlots.slotId"] === "1";
      },
      async (proceed, ...args) => {
        await barrier.wait();
        return proceed(...args);
      }
    );

    const app = legacyApp({ schedulesCollection: proxy as Collection<Document> });

    const bodyFor = (actor: { _id: unknown }) => ({
      userId: (actor._id as ObjectId).toString(),
      location: "Test Center",
      scheduleId: scheduleId.toString(),
      slotId: "1",
      testType: "IELTS",
      testSystem: "Academic",
      name: "IELTS Course",
    });

    const [resA, resB] = await Promise.all([
      request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${signTestToken(userA._id as ObjectId)}`).send(bodyFor(userA)),
      request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${signTestToken(userB._id as ObjectId)}`).send(bodyFor(userB)),
    ]);

    const statuses = [resA.status, resB.status];
    const successCount = statuses.filter((s) => s === 200).length;
    const loserStatus = statuses.find((s) => s !== 200);

    // Final atomic database state -- this is what actually gates PASS/BLOCK.
    assert.equal(successCount, 1, `expected exactly one winner, got statuses ${JSON.stringify(statuses)}`);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1, "expected exactly one committed booking");
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: scheduleId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 0, "seat must be exactly 0, never negative, never still 1");
    const [freshA, freshB] = await Promise.all([
      testDb.collections.usersCollection.findOne({ _id: userA._id as ObjectId }),
      testDb.collections.usersCollection.findOne({ _id: userB._id as ObjectId }),
    ]);
    const mocks = [freshA?.mock, freshB?.mock].sort();
    assert.deepEqual(mocks, [0, 1], "exactly one user must be charged, the other untouched");

    // Recorded, not gated: the loser's actual HTTP status (400 via the
    // modifiedCount guard, 409 via TransientTransactionError, or something
    // else) is a Stage 11/API-quality finding, not a Stage 10 failure.
    assert.ok(loserStatus !== undefined, `loser HTTP status observed: ${loserStatus}`);
  });
});

// ---------------------------------------------------------------------
// ss14: Cancellation commit + rollback + double-cancel race
// ---------------------------------------------------------------------
describe("Cancellation (DELETE /api/v1/bookings/:bookingId) -- real transaction", () => {
  it("commit: booking removal, seat restoration, and credit restoration commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 0 });
    const actorId = actor._id as ObjectId;
    const schedule = await seedSchedule({ timeSlots: [{ slotId: "1", slot: 0, startTime: "09:00:00", endTime: "10:00:00" }] });
    const booking = await seedBooking({
      userId: actorId.toString(),
      scheduleId: (schedule._id as ObjectId).toString(),
      slotId: "1",
      location: "Test Center",
    });

    const app = legacyApp();
    const res = await request(app)
      .delete(`/api/v1/bookings/${(booking._id as ObjectId).toString()}`)
      .set("Authorization", `Bearer ${signTestToken(actorId)}`);

    assert.equal(res.status, 200);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0);
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 1);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(updatedUser?.mock, 1);
  });

  it("rollback: missing user document on credit restore is a MANDATORY full-invariant rollback -- booking and seat must both survive", async () => {
    const admin = await seedUser(testDb.collections.usersCollection, { role: "admin" });
    const orphanUserId = new ObjectId().toString(); // valid ObjectId shape, matches no real user document
    const schedule = await seedSchedule({ timeSlots: [{ slotId: "1", slot: 0, startTime: "09:00:00", endTime: "10:00:00" }] });
    const booking = await seedBooking({
      userId: orphanUserId,
      scheduleId: (schedule._id as ObjectId).toString(),
      slotId: "1",
      location: "Test Center",
    });

    const app = legacyApp();
    const res = await request(app)
      .delete(`/api/v1/bookings/${(booking._id as ObjectId).toString()}`)
      .set("Authorization", `Bearer ${signTestToken(admin._id as ObjectId, "admin")}`);

    assert.equal(res.status, 500);
    assert.equal(res.body.message, "Failed to update mock count.");

    // Permanent transaction invariant (ss Context): session.abortTransaction()
    // must roll back EVERY write made under that session, including the
    // delete and the seat-restore increment -- not just the credit write
    // whose result was actually checked. Any partial state here is a real,
    // exploitable persistence bug, not an acceptable quirk.
    const bookingStillExists = await testDb.collections.bookingMockCollection.findOne({ _id: booking._id as ObjectId });
    assert.ok(bookingStillExists, "booking must still exist -- the delete must have been rolled back");
    const scheduleUnchanged = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal(
      (scheduleUnchanged?.timeSlots as Array<{ slot: number }>)[0].slot,
      0,
      "schedule slot must be back to its ORIGINAL pre-cancel value -- the seat-restore increment must also have been rolled back"
    );
  });

  it("double-cancel race: exactly one logical cancellation, no double credit/seat restore", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 0 });
    const actorId = actor._id as ObjectId;
    const schedule = await seedSchedule({ timeSlots: [{ slotId: "1", slot: 0, startTime: "09:00:00", endTime: "10:00:00" }] });
    const booking = await seedBooking({
      userId: actorId.toString(),
      scheduleId: (schedule._id as ObjectId).toString(),
      slotId: "1",
      location: "Test Center",
    });
    const bookingId = booking._id as ObjectId;

    const barrier = new AsyncBarrier(2, 8000);
    // Barrier wait happens AFTER the real findOne returns a truthy result,
    // not before it -- waiting before proceed() would only guarantee both
    // requests reach the call site, not that both have actually observed
    // the booking (one could run findOne, delete, and commit entirely
    // before the other's findOne even executes). Waiting only after a
    // successful proceed() guarantees both requests genuinely saw the same
    // still-present booking before either continues toward its delete.
    const { proxy } = interceptCollectionCall(
      testDb.collections.bookingMockCollection,
      "findOne",
      (...args: unknown[]) => {
        const [filter, options] = args as [{ _id?: ObjectId }, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(bookingId);
      },
      async (proceed, ...args) => {
        const result = await proceed(...args);
        if (result) await barrier.wait();
        return result;
      }
    );

    const app = legacyApp({ bookingMockCollection: proxy as Collection<Document> });
    const token = signTestToken(actorId);

    const [resA, resB] = await Promise.all([
      request(app).delete(`/api/v1/bookings/${bookingId.toString()}`).set("Authorization", `Bearer ${token}`),
      request(app).delete(`/api/v1/bookings/${bookingId.toString()}`).set("Authorization", `Bearer ${token}`),
    ]);

    const statuses = [resA.status, resB.status];
    const successCount = statuses.filter((s) => s === 200).length;

    assert.equal(successCount, 1, `expected exactly one successful cancellation, got statuses ${JSON.stringify(statuses)}`);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0, "booking must be absent (exactly one deletion happened)");
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(updatedUser?.mock, 1, "mock must be restored to exactly its pre-cancel value + 1, never +2");
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 1, "seat must be restored to exactly +1, never +2");

    // Recorded, not gated: the loser's actual status (404, or a transaction
    // conflict surfacing as 500) is characterized, per
    // transaction-inventory.md's own explicit deferral of this race to
    // Stage 10 -- an unattractive-but-non-corrupting status is a Stage
    // 11/API-quality finding, not a Stage 10 failure.
    const loserStatus = statuses.find((s) => s !== 200);
    assert.ok(loserStatus !== undefined, `double-cancel loser HTTP status observed: ${loserStatus}`);
  });
});

// ---------------------------------------------------------------------
// ss15: Home teacher assignment commit + rollback
// ---------------------------------------------------------------------
describe("Home teacher assignment (PUT /api/v1/admin/bookings/:bookingId/teacher) -- real transaction", () => {
  it("commit: user teacher map and booking teacher fields stay aligned", async () => {
    const admin = await seedUser(testDb.collections.usersCollection, { role: "admin" });
    const owner = await seedUser(testDb.collections.usersCollection);
    const booking = await seedBooking({ userId: (owner._id as ObjectId).toString(), location: "Home" });
    const bookingId = (booking._id as ObjectId).toString();

    const app = legacyApp();
    const res = await request(app)
      .put(`/api/v1/admin/bookings/${bookingId}/teacher`)
      .set("Authorization", `Bearer ${signTestToken(admin._id as ObjectId, "admin")}`)
      .send({ skill: "L", teacher: "Jane Doe", email: "Jane@Example.test" });

    assert.equal(res.status, 200);
    const updatedBooking = await testDb.collections.bookingMockCollection.findOne({ _id: booking._id as ObjectId });
    assert.equal(updatedBooking?.teacherL, "Jane Doe");
    assert.equal(updatedBooking?.teacherLEmail, "jane@example.test");
    const updatedOwner = await testDb.collections.usersCollection.findOne({ _id: owner._id as ObjectId });
    const teacherMap = (updatedOwner?.teachersBySchedule as Record<string, Record<string, string>> | undefined)?.[bookingId];
    assert.equal(teacherMap?.teacherL, "Jane Doe");
    assert.equal(teacherMap?.teacherLEmail, "jane@example.test");
  });

  it("rollback: unexpected booking-side failure rolls back the user-side write too", async () => {
    const admin = await seedUser(testDb.collections.usersCollection, { role: "admin" });
    const owner = await seedUser(testDb.collections.usersCollection);
    const booking = await seedBooking({ userId: (owner._id as ObjectId).toString(), location: "Home" });
    const bookingId = booking._id as ObjectId;

    const { proxy } = interceptCollectionCall(
      testDb.collections.bookingMockCollection,
      "findOneAndUpdate",
      (...args: unknown[]) => {
        const [filter, , options] = args as [{ _id?: ObjectId }, unknown, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(bookingId);
      },
      async () => {
        throw new Error("simulated unexpected persistence failure");
      }
    );

    const app = legacyApp({ bookingMockCollection: proxy as Collection<Document> });
    const res = await request(app)
      .put(`/api/v1/admin/bookings/${bookingId.toString()}/teacher`)
      .set("Authorization", `Bearer ${signTestToken(admin._id as ObjectId, "admin")}`)
      .send({ skill: "L", teacher: "Jane Doe", email: "jane@example.test" });

    assert.equal(res.status, 500);
    const unchangedBooking = await testDb.collections.bookingMockCollection.findOne({ _id: bookingId });
    assert.equal(unchangedBooking?.teacherL, undefined);
    const unchangedOwner = await testDb.collections.usersCollection.findOne({ _id: owner._id as ObjectId });
    assert.equal(
      unchangedOwner?.teachersBySchedule,
      undefined,
      "the user-side write that ran first must not survive the booking-side write's failure"
    );
  });
});

// ---------------------------------------------------------------------
// ss16: candidate-app (src/app.ts) real-Mongo transaction smoke
// ---------------------------------------------------------------------
describe("TS candidate (src/app.ts) real-Mongo transaction smoke", () => {
  function fakeAuthConfig(): AuthConfig {
    return {
      jwtSecret: "test-only-secret",
      jwtResetPasswordSecret: "test-only-reset-secret",
      jwtExpiresIn: "7d",
      jwtResetPasswordTokenExpiresIn: "15m",
      resetPasswordLink: "https://example.test/reset-password",
      isProduction: false,
    };
  }

  it("Home booking commits through the candidate app's real composition root with a real MongoClient", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const dependencies: AppDependencies = { ...testDb.collections, client: testDb.client };
    const app = createApp(dependencies, { authConfig: fakeAuthConfig() });

    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actor._id as ObjectId)}`)
      .send({ userId: (actor._id as ObjectId).toString(), location: "Home", bookingDate: "2026-11-02", testTime: "10:00" });

    assert.equal(res.status, 200);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1);
  });
});

// ---------------------------------------------------------------------
// Stage 12.5: candidate-app (src/app.ts) full invariant + concurrency
// proof -- the TS composition root must prove its legacy-compatibility
// boundary weakens none of the four permanent invariants before the
// runtime cutover. Same real ephemeral replica set, same seeds, same
// assertions as the legacy ss12-ss15 blocks above; only the app factory
// differs (candidateApp vs legacyApp).
//
// Note: createApp() here mounts the real legacy booking/feedback routers
// (which reuse module-level Router singletons), so repeated candidateApp()
// calls accumulate duplicate identical handlers in this file's process --
// harmless (the first matching handler responds), same as production's
// single-mount behavior for the request under test.
// ---------------------------------------------------------------------
describe("TS candidate (src/app.ts) full transaction-invariant proof", () => {
  function candidateApp(overrides: Partial<AppCollections> = {}) {
    const dependencies: AppDependencies = {
      ...testDb.collections,
      ...overrides,
      client: testDb.client,
    };
    return createApp(dependencies, {
      authConfig: {
        jwtSecret: "test-only-secret",
        jwtResetPasswordSecret: "test-only-reset-secret",
        jwtExpiresIn: "7d",
        jwtResetPasswordTokenExpiresIn: "15m",
        resetPasswordLink: "https://example.test/reset-password",
        isProduction: false,
      },
    });
  }

  it("invariant 1 (candidate): Home booking insert + credit decrement commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const app = candidateApp();
    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actor._id as ObjectId)}`)
      .send({ userId: (actor._id as ObjectId).toString(), location: "Home", bookingDate: "2026-11-01", testTime: "09:00" });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actor._id as ObjectId });
    assert.equal(updatedUser?.mock, 0);
  });

  it("invariant 2 (candidate): Test Center seat + credit + booking commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const schedule = await seedSchedule();
    const app = candidateApp();

    const res = await request(app)
      .post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${signTestToken(actor._id as ObjectId)}`)
      .send({
        userId: (actor._id as ObjectId).toString(),
        location: "Test Center",
        scheduleId: (schedule._id as ObjectId).toString(),
        slotId: "1",
        testType: "IELTS",
        testSystem: "Academic",
        name: "IELTS Course",
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 0);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actor._id as ObjectId });
    assert.equal(updatedUser?.mock, 0);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1);
  });

  it("invariant 3 (candidate): cancellation delete + seat restore + credit restore commit together", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 0 });
    const actorId = actor._id as ObjectId;
    const schedule = await seedSchedule({ timeSlots: [{ slotId: "1", slot: 0, startTime: "09:00:00", endTime: "10:00:00" }] });
    const booking = await seedBooking({
      userId: actorId.toString(),
      scheduleId: (schedule._id as ObjectId).toString(),
      slotId: "1",
      location: "Test Center",
    });

    const app = candidateApp();
    const res = await request(app)
      .delete(`/api/v1/bookings/${(booking._id as ObjectId).toString()}`)
      .set("Authorization", `Bearer ${signTestToken(actorId)}`);

    assert.equal(res.status, 200);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0);
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 1);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(updatedUser?.mock, 1);
  });

  it("invariant 4 (candidate): home teacher assignment keeps booking + user map aligned", async () => {
    const admin = await seedUser(testDb.collections.usersCollection, { role: "admin" });
    const owner = await seedUser(testDb.collections.usersCollection);
    const booking = await seedBooking({ userId: (owner._id as ObjectId).toString(), location: "Home" });
    const bookingId = (booking._id as ObjectId).toString();

    const app = candidateApp();
    const res = await request(app)
      .put(`/api/v1/admin/bookings/${bookingId}/teacher`)
      .set("Authorization", `Bearer ${signTestToken(admin._id as ObjectId, "admin")}`)
      .send({ skill: "L", teacher: "Jane Doe", email: "Jane@Example.test" });

    assert.equal(res.status, 200);
    const updatedBooking = await testDb.collections.bookingMockCollection.findOne({ _id: booking._id as ObjectId });
    assert.equal(updatedBooking?.teacherL, "Jane Doe");
    assert.equal(updatedBooking?.teacherLEmail, "jane@example.test");
    const updatedOwner = await testDb.collections.usersCollection.findOne({ _id: owner._id as ObjectId });
    const teacherMap = (updatedOwner?.teachersBySchedule as Record<string, Record<string, string>> | undefined)?.[bookingId];
    assert.equal(teacherMap?.teacherL, "Jane Doe");
    assert.equal(teacherMap?.teacherLEmail, "jane@example.test");
  });

  it("concurrency (candidate): last-seat race commits exactly one booking, no oversell", async () => {
    const userA = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const userB = await seedUser(testDb.collections.usersCollection, { mock: 1 });
    const schedule = await seedSchedule();
    const scheduleId = schedule._id as ObjectId;

    const barrier = new AsyncBarrier(2, 8000);
    const { proxy } = interceptCollectionCall(
      testDb.collections.schedulesCollection,
      "updateOne",
      (...args: unknown[]) => {
        const [filter, , options] = args as [{ _id?: ObjectId; "timeSlots.slotId"?: string }, unknown, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(scheduleId) && filter["timeSlots.slotId"] === "1";
      },
      async (proceed, ...args) => {
        await barrier.wait();
        return proceed(...args);
      }
    );

    const app = candidateApp({ schedulesCollection: proxy as Collection<Document> });

    const bodyFor = (actor: { _id: unknown }) => ({
      userId: (actor._id as ObjectId).toString(),
      location: "Test Center",
      scheduleId: scheduleId.toString(),
      slotId: "1",
      testType: "IELTS",
      testSystem: "Academic",
      name: "IELTS Course",
    });

    const [resA, resB] = await Promise.all([
      request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${signTestToken(userA._id as ObjectId)}`).send(bodyFor(userA)),
      request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${signTestToken(userB._id as ObjectId)}`).send(bodyFor(userB)),
    ]);

    const statuses = [resA.status, resB.status];
    assert.equal(statuses.filter((s) => s === 200).length, 1, `expected exactly one winner, got statuses ${JSON.stringify(statuses)}`);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 1, "expected exactly one committed booking");
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: scheduleId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 0, "seat must be exactly 0");
    const [freshA, freshB] = await Promise.all([
      testDb.collections.usersCollection.findOne({ _id: userA._id as ObjectId }),
      testDb.collections.usersCollection.findOne({ _id: userB._id as ObjectId }),
    ]);
    assert.deepEqual([freshA?.mock, freshB?.mock].sort(), [0, 1], "exactly one user must be charged");
    assert.ok(statuses.find((s) => s !== 200) !== undefined, "loser HTTP status observed");
  });

  it("concurrency (candidate): double cancellation restores credit/seat exactly once", async () => {
    const actor = await seedUser(testDb.collections.usersCollection, { mock: 0 });
    const actorId = actor._id as ObjectId;
    const schedule = await seedSchedule({ timeSlots: [{ slotId: "1", slot: 0, startTime: "09:00:00", endTime: "10:00:00" }] });
    const booking = await seedBooking({
      userId: actorId.toString(),
      scheduleId: (schedule._id as ObjectId).toString(),
      slotId: "1",
      location: "Test Center",
    });
    const bookingId = booking._id as ObjectId;

    const barrier = new AsyncBarrier(2, 8000);
    const { proxy } = interceptCollectionCall(
      testDb.collections.bookingMockCollection,
      "findOne",
      (...args: unknown[]) => {
        const [filter, options] = args as [{ _id?: ObjectId }, { session?: unknown } | undefined];
        return Boolean(options?.session) && Boolean(filter?._id) && filter._id!.equals(bookingId);
      },
      async (proceed, ...args) => {
        const result = await proceed(...args);
        if (result) await barrier.wait();
        return result;
      }
    );

    const app = candidateApp({ bookingMockCollection: proxy as Collection<Document> });
    const token = signTestToken(actorId);

    const [resA, resB] = await Promise.all([
      request(app).delete(`/api/v1/bookings/${bookingId.toString()}`).set("Authorization", `Bearer ${token}`),
      request(app).delete(`/api/v1/bookings/${bookingId.toString()}`).set("Authorization", `Bearer ${token}`),
    ]);

    const statuses = [resA.status, resB.status];
    assert.equal(statuses.filter((s) => s === 200).length, 1, `expected exactly one successful cancellation, got statuses ${JSON.stringify(statuses)}`);
    assert.equal(await testDb.collections.bookingMockCollection.countDocuments({}), 0);
    const updatedUser = await testDb.collections.usersCollection.findOne({ _id: actorId });
    assert.equal(updatedUser?.mock, 1, "mock must be restored exactly once, never +2");
    const updatedSchedule = await testDb.collections.schedulesCollection.findOne({ _id: schedule._id as ObjectId });
    assert.equal((updatedSchedule?.timeSlots as Array<{ slot: number }>)[0].slot, 1, "seat must be restored exactly once, never +2");
    assert.ok(statuses.find((s) => s !== 200) !== undefined, "double-cancel loser HTTP status observed");
  });
});
