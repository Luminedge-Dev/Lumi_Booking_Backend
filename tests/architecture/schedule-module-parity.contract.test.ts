// Proves the native TypeScript Schedule module (src/app/modules/schedule,
// mounted by src/app.ts) matches the legacy contract locked in
// tests/characterization/schedule.contract.test.ts for all 4 migrated
// routes, proves the new monthly route's full contract, proves the
// mandatory route-order guard, and proves GET /schedule/:userId still
// reaches the legacy handler unmodified (deliberately not migrated).
//
// Like Stage 8's user-module-parity file, this one deliberately exercises
// FALLTHROUGH to the still-mounted legacy scheduleRoutes() router
// (/schedule/:userId), which is guarded by middleware/auth.js's verifyToken
// -- that reads process.env.JWT_SECRET directly, independent of the native
// module's fakeAuthConfig(). Both must agree or legacy's verifyToken fails
// signature verification against a token signed for the native module.
//
// src/app/modules/schedule/schedule.route.ts calls Router() fresh inside
// createScheduleRouter() every time, so no require-cache-busting is needed
// here (same pattern as every other native module's parity test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";
import { FakeSchedulesCollection, type FakeScheduleDoc } from "../helpers/fake-schedules-collection";

process.env.JWT_SECRET = "test-only-secret";

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

function appWith(usersCollection: FakeUsersCollection, schedulesCollection: FakeSchedulesCollection) {
  const dependencies: AppDependencies = {
    usersCollection: usersCollection as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: schedulesCollection as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, { authConfig: fakeAuthConfig() });
}

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}@example.test`, password: "x", role };
}

describe("native Schedule module parity: POST /api/v1/admin/create-schedule", () => {
  it("non-admin -> 403, identical to legacy", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(user._id)}`)
      .send([]);
    assert.equal(res.status, 403);
  });

  it("single valid row -> 201, identical shape to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.successfulSchedules[0].assignedSlotId, "1");
  });

  it("mixed valid+invalid -> 207, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
        { startDate: "2026-10-06" },
      ]);
    assert.equal(res.status, 207);
  });

  it("non-array body -> 409, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send({ notAnArray: true });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { success: false, message: "No schedules created.", successfulSchedules: [], failedSchedules: [] });
  });

  it("unexpected mid-batch failure -> 500, earlier insert remains persisted (no rollback), identical to legacy", async () => {
    const admin = makeUser("admin");
    class ThrowingSchedulesCollection extends FakeSchedulesCollection {
      private count = 0;
      async insertOne(doc: FakeScheduleDoc) {
        this.count += 1;
        if (this.count === 2) throw new Error("simulated failure");
        return super.insertOne(doc);
      }
    }
    const schedules = new ThrowingSchedulesCollection();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
        { courseId: "c2", startDate: "2026-10-06", endDate: "2026-10-06", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    assert.equal((schedules.find() as FakeScheduleDoc[]).length, 1);
  });

  // --- Stage 9 closure patch parity additions -------------------------

  it("CLOSURE PATCH: no testType -> persisted doc has testType=='', and a second no-testType request matches legacy's observed (non-incrementing) slotId, identical to legacy", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    assert.strictEqual(stored.testType, "");

    const res2 = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "11:00", endTime: "12:00" }] }]);
    // Matches the observed legacy value characterized in
    // tests/characterization/schedule.contract.test.ts -- NOT "2".
    assert.equal(res2.body.successfulSchedules[0].assignedSlotId, "1");
  });

  it("CLOSURE PATCH: falsy-non-nullish courseId (0) in failedSchedules[] uses || semantics, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: 0, startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.failedSchedules[0], {
      courseId: "",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      message: "Missing courseId/startDate/endDate",
      timestamp: res.body.failedSchedules[0].timestamp,
    });
  });

  it("CLOSURE PATCH: timeSlots:[false] normalizes without throwing, identical to legacy", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [false] }]);
    assert.equal(res.status, 201);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    const slot = (stored.timeSlots as Array<Record<string, unknown>>)[0];
    assert.equal(slot.startTime, "00:00:00");
    assert.equal(slot.endTime, "00:00:00");
    assert.strictEqual(slot.slot, 0);
    assert.strictEqual(slot.totalSlot, 0);
  });

  it("CLOSURE PATCH: timeSlots:[null] -> 500, no document persisted, identical to legacy (not silently accepted as an empty slot)", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [null] }]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    assert.equal((schedules.find() as FakeScheduleDoc[]).length, 0);
  });

  it("CLOSURE PATCH: startTime:false normalizes to the same value legacy produces (String(v || \"\"), not String(v ?? \"\"))", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: false, endTime: "10:00" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    const slot = (stored.timeSlots as Array<Record<string, unknown>>)[0];
    assert.equal(slot.startTime, "00:00:00");
    assert.equal(slot.endTime, "10:00:00");
  });

  it("CLOSURE PATCH: max-slot-ID read occurs before the empty-timeSlots check -- a DB failure there surfaces as 500 even with no timeSlots, identical to legacy", async () => {
    const admin = makeUser("admin");
    class ThrowingMaxSlotCollection extends FakeSchedulesCollection {
      aggregate(pipeline: Array<Record<string, unknown>>, options?: { maxTimeMS?: number }) {
        const hasUnwind = pipeline.some((stage) => "$unwind" in stage);
        if (hasUnwind) {
          return {
            toArray: async () => {
              throw new Error("simulated max-slot-ID query failure");
            },
          };
        }
        return super.aggregate(pipeline, options);
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new ThrowingMaxSlotCollection());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
  });
});

describe("native Schedule module parity: GET /api/v1/schedule/:date/:courseId", () => {
  it("authenticated, exact match, identical to legacy", async () => {
    const user = makeUser("user");
    const doc: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "1" }],
    };
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection([doc]));
    const res = await request(app).get("/api/v1/schedule/2026-10-05/c1").set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
  });

  it("Cancelled excluded, identical to legacy", async () => {
    const user = makeUser("user");
    const cancelled: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Cancelled",
      timeSlots: [{ slotId: "1" }],
    };
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection([cancelled]));
    const res = await request(app).get("/api/v1/schedule/2026-10-05/c1").set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("numeric slotId sort preserved: '2' before '10'", async () => {
    const user = makeUser("user");
    const slotTen: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", status: "Scheduled", timeSlots: [{ slotId: "10" }] };
    const slotTwo: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", status: "Scheduled", timeSlots: [{ slotId: "2" }] };
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection([slotTen, slotTwo]));
    const res = await request(app).get("/api/v1/schedule/2026-10-05/c1").set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.body.schedules[0]._id, slotTwo._id.toString());
    assert.equal(res.body.schedules[1]._id, slotTen._id.toString());
  });

  it("no token -> 401, never a misleading 400/403", async () => {
    const app = appWith(new FakeUsersCollection(), new FakeSchedulesCollection());
    const res = await request(app).get("/api/v1/schedule/2026-10-05/c1");
    assert.equal(res.status, 401);
  });
});

describe("native Schedule module parity: GET /api/v1/admin/get-schedules", () => {
  it("admin/bdm/teacher allowed, normal user denied, identical to legacy", async () => {
    const schedules = new FakeSchedulesCollection();
    for (const role of ["admin", "bdm", "teacher"]) {
      const actor = makeUser(role);
      const app = appWith(new FakeUsersCollection([actor]), schedules);
      const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(actor._id, role)}`);
      assert.equal(res.status, 200, `role ${role} should be allowed`);
    }
    const normal = makeUser("user");
    const app = appWith(new FakeUsersCollection([normal]), schedules);
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(normal._id)}`);
    assert.equal(res.status, 403);
  });

  it("pagination/filters/{schedules,total,page,limit} shape, identical to legacy", async () => {
    const admin = makeUser("admin");
    const docs = Array.from({ length: 3 }, () => ({ _id: new ObjectId(), courseId: "c1" }) as FakeScheduleDoc);
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection(docs));
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 100);
  });

  it("504 timeout preservation: err.code===50 -> 'Query timed out.', identical to legacy", async () => {
    const admin = makeUser("admin");
    class TimeoutSchedulesCollection extends FakeSchedulesCollection {
      find(): FakeScheduleDoc[];
      find(filter: Record<string, unknown>): ReturnType<FakeSchedulesCollection["find"]>;
      find(filter?: Record<string, unknown>): unknown {
        if (filter === undefined) return super.find();
        const timeoutCursor = {
          sort: () => timeoutCursor,
          skip: () => timeoutCursor,
          limit: () => timeoutCursor,
          maxTimeMS: () => timeoutCursor,
          toArray: async () => {
            throw Object.assign(new Error("MaxTimeMSExpired"), { code: 50 });
          },
        };
        return timeoutCursor;
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new TimeoutSchedulesCollection());
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 504);
    assert.deepEqual(res.body, { message: "Query timed out." });
  });
});

describe("native Schedule module parity: DELETE /api/v1/admin/delete-schedule/:id", () => {
  it("success -> 200, document removed, identical to legacy", async () => {
    const admin = makeUser("admin");
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1" };
    const schedules = new FakeSchedulesCollection([doc]);
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${doc._id}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.equal((schedules.find() as FakeScheduleDoc[]).length, 0);
  });

  it("invalid ObjectId -> 400, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app).delete("/api/v1/admin/delete-schedule/not-a-valid-id").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid schedule ID format." });
  });

  it("missing schedule -> 404, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeSchedulesCollection());
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${new ObjectId()}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 404);
  });

  it("HARD DELETE PRESERVED: a referencing booking fixture is untouched by schedule deletion (documents, does not endorse, the orphan risk)", async () => {
    const admin = makeUser("admin");
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1" };
    const schedules = new FakeSchedulesCollection([doc]);
    // bookingMockCollection is a throwingCollection in appWith() -- this
    // route never queries it at all, proving no cross-collection check was
    // introduced.
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${doc._id}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
  });
});

describe("native Schedule module: new GET /api/v1/schedule/course/:courseId?month=YYYY-MM contract", () => {
  it("no token -> 401", async () => {
    const app = appWith(new FakeUsersCollection(), new FakeSchedulesCollection());
    const res = await request(app).get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-10`);
    assert.equal(res.status, 401);
  });

  it("missing month -> 400 {message:'Invalid month. Expected YYYY-MM.'}", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app).get(`/api/v1/schedule/course/${new ObjectId()}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid month. Expected YYYY-MM." });
  });

  it("invalid month -> 400", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app)
      .get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-13`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
  });

  it("invalid courseId -> 400 {message:'Invalid course ID.'}", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app)
      .get("/api/v1/schedule/course/not-a-valid-id?month=2026-10")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid course ID." });
  });

  it("valid request: only the requested course, only the requested month, Cancelled excluded", async () => {
    const user = makeUser("user");
    const courseId = new ObjectId().toHexString();
    const inMonth: FakeScheduleDoc = { _id: new ObjectId(), courseId, startDate: "2026-10-15", status: "Scheduled" };
    const outOfMonth: FakeScheduleDoc = { _id: new ObjectId(), courseId, startDate: "2026-11-01", status: "Scheduled" };
    const cancelled: FakeScheduleDoc = { _id: new ObjectId(), courseId, startDate: "2026-10-20", status: "Cancelled" };
    const otherCourse: FakeScheduleDoc = { _id: new ObjectId(), courseId: new ObjectId().toHexString(), startDate: "2026-10-15", status: "Scheduled" };
    const schedules = new FakeSchedulesCollection([inMonth, outOfMonth, cancelled, otherCourse]);
    const app = appWith(new FakeUsersCollection([user]), schedules);
    const res = await request(app).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, inMonth._id.toString());
  });

  it("no matches -> 200 {schedules:[]}, not 404", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app)
      .get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-10`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("MANDATORY ROUTE-ORDER GATE: /schedule/course/:courseId is never captured by the generic /schedule/:date/:courseId pattern", async () => {
    const user = makeUser("user");
    const courseId = new ObjectId().toHexString();
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId, startDate: "2026-10-15", status: "Scheduled" };
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection([doc]));
    const res = await request(app).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${signToken(user._id)}`);
    // If the daily route had captured this request, it would interpret
    // date="course" and courseId=<the real id>, matching nothing (since no
    // document has startDate==="course") and returning an empty array --
    // this assertion would fail if that collision existed.
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
  });
});

describe("GET /api/v1/schedule/:userId (parity gate -- deliberately NOT migrated)", () => {
  it("still reaches the legacy handler unmodified through the full native app.ts", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeSchedulesCollection());
    const res = await request(app).get(`/api/v1/schedule/${new ObjectId().toString()}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });
});
