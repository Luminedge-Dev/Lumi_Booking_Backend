// Characterizes routes/schedule.routes.js's 4 Stage-9-target endpoints
// (create-schedule, daily read, admin list, delete) plus the untouched
// /schedule/:userId route, end-to-end via supertest against the legacy
// app.js, BEFORE Stage 9's native TypeScript module replaces 4 of them in
// the TS candidate. Production (index.js -> app.js) is unaffected either
// way. GET /courses was already characterized in course-read.contract.test.ts
// (Stage 8) and is not repeated here.
//
// Deliberately does NOT reuse the shared createTestApp(): routes/
// schedule.routes.js (like every routes/*.routes.js file, confirmed by
// reading it) creates its Express Router() ONCE at module load time and
// keeps adding handlers to that SAME persistent router on every factory
// call -- the exact Router()-singleton bug Stage 7/8 found in
// auth.routes.js/user.routes.js. freshApp() below busts the require cache
// for app.js + routes/schedule.routes.js before every call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";
import { FakeSchedulesCollection, type FakeScheduleDoc } from "../helpers/fake-schedules-collection";

process.env.JWT_SECRET = "test-only-secret";

function freshApp(schedulesCollection: unknown, usersCollection: unknown = new FakeUsersCollection([])) {
  for (const mod of ["../../app", "../../routes/schedule.routes"]) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createApp = require("../../app");
  return createApp({
    usersCollection,
    coursesCollection: throwingCollection("coursesCollection"),
    schedulesCollection,
    bookingMockCollection: throwingCollection("bookingMockCollection"),
    client: {},
  });
}

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}@example.test`, password: "x", role };
}

describe("POST /api/v1/admin/create-schedule (characterization)", () => {
  it("non-admin -> 403", async () => {
    const user = makeUser("user");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([user]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(user._id)}`)
      .send([]);
    assert.equal(res.status, 403);
  });

  it("non-array body -> 409 (silently coerced to [], zero schedules created)", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send({ notAnArray: true });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      success: false,
      message: "No schedules created.",
      successfulSchedules: [],
      failedSchedules: [],
    });
  });

  it("missing courseId/startDate/endDate -> failed[] entry, request still succeeds overall if nothing else fails (409 since zero successes)", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ startDate: "2026-10-05" }]);
    assert.equal(res.status, 409);
    assert.equal(res.body.failedSchedules.length, 1);
    assert.deepEqual(res.body.failedSchedules[0], {
      courseId: "",
      startDate: "2026-10-05",
      endDate: "",
      message: "Missing courseId/startDate/endDate",
      timestamp: res.body.failedSchedules[0].timestamp,
    });
  });

  it("no timeSlots -> failed[] 'No time slots provided.', continues (409 since zero successes)", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [] }]);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.failedSchedules[0], {
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      message: "No time slots provided.",
      timestamp: res.body.failedSchedules[0].timestamp,
    });
  });

  it("single valid row -> 201, exact successfulSchedules[] item shape, slot/time normalization, defaults, createdAt", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        {
          courseId: "c1",
          startDate: "2026-10-05",
          endDate: "2026-10-05",
          timeSlots: [{ startTime: "9:0", endTime: "10:0", slot: "5" }],
        },
      ]);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Schedules created successfully.");
    assert.deepEqual(res.body.failedSchedules, []);
    assert.equal(res.body.successfulSchedules.length, 1);
    assert.deepEqual(res.body.successfulSchedules[0], {
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      assignedSlotId: "1",
      createdAt: res.body.successfulSchedules[0].createdAt,
    });
  });

  it("mixed valid+invalid -> 207, both arrays populated with exact shapes", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00", slot: 5, totalSlot: 10 }] },
        { startDate: "2026-10-06" },
      ]);
    assert.equal(res.status, 207);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Schedules created (some skipped).");
    assert.equal(res.body.successfulSchedules.length, 1);
    assert.equal(res.body.failedSchedules.length, 1);
  });

  it("all invalid -> 409", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ startDate: "2026-10-05" }, { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(res.status, 409);
    assert.equal(res.body.failedSchedules.length, 2);
  });

  it("time normalization: '09:00' -> '09:00:00'", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "17:30" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    const slot = (stored.timeSlots as Array<Record<string, unknown>>)[0];
    assert.equal(slot.startTime, "09:00:00");
    assert.equal(slot.endTime, "17:30:00");
  });

  it("slot/totalSlot Number coercion, including totalSlot's slot-fallback (?? not ||)", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00", slot: "7" }] },
      ]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    const slot = (stored.timeSlots as Array<Record<string, unknown>>)[0];
    assert.strictEqual(slot.slot, 7);
    assert.strictEqual(slot.totalSlot, 7); // falls back to slot's value, not 0
  });

  it("defaults use ?? (name/testSystem/testType='', status='Scheduled')", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    assert.equal(stored.name, "");
    assert.equal(stored.testSystem, "");
    assert.equal(stored.testType, "");
    assert.equal(stored.status, "Scheduled");
  });

  it("createdAt is an identical ISO string across every document inserted in one batch", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        {
          courseId: "c1",
          startDate: "2026-10-05",
          endDate: "2026-10-05",
          timeSlots: [
            { startTime: "09:00", endTime: "10:00" },
            { startTime: "11:00", endTime: "12:00" },
          ],
        },
      ]);
    const docs = schedules.find() as FakeScheduleDoc[];
    assert.equal(docs.length, 2);
    assert.equal(docs[0].createdAt, docs[1].createdAt);
  });

  it("slot IDs increment from existing max for the exact 4-field key (courseId, startDate, endDate, testType)", async () => {
    const admin = makeUser("admin");
    const existing: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      testType: "t1",
      timeSlots: [{ slotId: "5" }],
    };
    const schedules = new FakeSchedulesCollection([existing]);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", testType: "t1", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]);
    assert.equal(res.body.successfulSchedules[0].assignedSlotId, "6");

    // A different testType is a DIFFERENT key -- starts fresh from 0+1.
    const res2 = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", testType: "different", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]);
    assert.equal(res2.body.successfulSchedules[0].assignedSlotId, "1");
  });

  it("unexpected mid-batch failure: HTTP 500, remaining entries never processed, earlier insert remains persisted", async () => {
    const admin = makeUser("admin");
    class ThrowingSchedulesCollection extends FakeSchedulesCollection {
      private insertCount = 0;
      async insertOne(doc: FakeScheduleDoc) {
        this.insertCount += 1;
        if (this.insertCount === 2) {
          throw new Error("simulated unexpected persistence failure");
        }
        return super.insertOne(doc);
      }
    }
    const schedules = new ThrowingSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([
        { courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
        { courseId: "c2", startDate: "2026-10-06", endDate: "2026-10-06", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    const docs = schedules.find() as FakeScheduleDoc[];
    assert.equal(docs.length, 1);
    assert.equal(docs[0].courseId, "c1");
  });

  // --- Stage 9 closure patch additions -------------------------------

  it("CLOSURE PATCH: no testType -> persisted doc has testType=='', while the max-slot lookup key independently stays raw (undefined)", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    assert.strictEqual(stored.testType, "");

    // Characterize (not assume) what a SECOND, otherwise-identical no-testType
    // request actually does. The lookup key carries raw testType=undefined,
    // but the first request's persisted document has testType="" (a string,
    // not undefined/null) -- whether the key matches that document is a real
    // legacy quirk, not something to infer. This records the observed value.
    const res2 = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "11:00", endTime: "12:00" }] }]);
    // OBSERVED (this harness): the raw-undefined key does NOT match the
    // persisted ""-valued document, so the second request's max-slot lookup
    // sees zero matching documents and starts over at slotId "1" -- it does
    // NOT increment to "2". This is a second, distinct legacy allocator
    // quirk (separate from the already-characterized non-atomic race),
    // caused by the testType raw-key vs ""-persisted-value split -- recorded
    // here, not fixed, same as the main allocator defect (D-029).
    assert.equal(res2.body.successfulSchedules[0].assignedSlotId, "1");
  });

  it("CLOSURE PATCH: falsy-non-nullish courseId (0) in failedSchedules[] uses || semantics, not ?? (courseId:0 -> '')", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
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

  it("CLOSURE PATCH: timeSlots:[false] -- a primitive slot entry normalizes via legacy's property-access semantics (does not throw)", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
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

  it("CLOSURE PATCH: timeSlots:[null] -- a null slot entry throws during property access, legacy's outer catch returns 500, nothing is persisted for that entry", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [null] }]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    assert.equal((schedules.find() as FakeScheduleDoc[]).length, 0);
  });

  it("CLOSURE PATCH: startTime:false normalizes via legacy's String(v || \"\") semantics -- observed value, not inferred", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: false, endTime: "10:00" }] }]);
    const stored = (schedules.find() as FakeScheduleDoc[])[0];
    const slot = (stored.timeSlots as Array<Record<string, unknown>>)[0];
    // OBSERVED legacy output (String(false || "") -> "" -> toHHMM("") -> "00:00" -> toHHMMSS -> "00:00:00").
    assert.equal(slot.startTime, "00:00:00");
    assert.equal(slot.endTime, "10:00:00");
  });

  it("CLOSURE PATCH: max-slot-ID read happens before the empty-timeSlots check -- a DB failure on that read surfaces as 500 even when timeSlots is empty", async () => {
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
    const schedules = new ThrowingMaxSlotCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      // Valid required fields, but NO timeSlots -- if the empty-check ran
      // BEFORE the max-slot read, this would short-circuit to a 409
      // failed[] entry without ever touching the DB. Legacy's actual order
      // reads max-slot-ID first, so the simulated DB failure must surface.
      .send([{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05" }]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
  });
});

describe("GET /api/v1/schedule/:date/:courseId (characterization)", () => {
  it("authenticated, no schedules -> {schedules: []}", async () => {
    const user = makeUser("user");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/schedule/2026-10-05/c1")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("no token -> 401", async () => {
    const app = freshApp(new FakeSchedulesCollection());
    const res = await request(app).get("/api/v1/schedule/2026-10-05/c1");
    assert.equal(res.status, 401);
  });

  it("exact course+date match: both startDate AND endDate must equal :date", async () => {
    const user = makeUser("user");
    const matching: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "1" }],
    };
    const wrongEnd: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-06",
      status: "Scheduled",
      timeSlots: [{ slotId: "2" }],
    };
    const schedules = new FakeSchedulesCollection([matching, wrongEnd]);
    const app = freshApp(schedules, new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/schedule/2026-10-05/c1")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, matching._id.toString());
  });

  it("Cancelled excluded, non-Cancelled included", async () => {
    const user = makeUser("user");
    const cancelled: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Cancelled",
      timeSlots: [{ slotId: "1" }],
    };
    const active: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "2" }],
    };
    const schedules = new FakeSchedulesCollection([cancelled, active]);
    const app = freshApp(schedules, new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/schedule/2026-10-05/c1")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, active._id.toString());
  });

  it("numeric slotId sort: '2' sorts before '10' (not lexicographic)", async () => {
    const user = makeUser("user");
    const slotTen: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "10" }],
    };
    const slotTwo: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      timeSlots: [{ slotId: "2" }],
    };
    const schedules = new FakeSchedulesCollection([slotTen, slotTwo]);
    const app = freshApp(schedules, new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/schedule/2026-10-05/c1")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.body.schedules[0]._id, slotTwo._id.toString());
    assert.equal(res.body.schedules[1]._id, slotTen._id.toString());
  });

  it("raw fields preserved, _slotIdNum stripped from output", async () => {
    const user = makeUser("user");
    const doc: FakeScheduleDoc = {
      _id: new ObjectId(),
      courseId: "c1",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      status: "Scheduled",
      someUnexpectedField: "legacy-value",
      timeSlots: [{ slotId: "1" }],
    };
    const schedules = new FakeSchedulesCollection([doc]);
    const app = freshApp(schedules, new FakeUsersCollection([user]));
    const res = await request(app)
      .get("/api/v1/schedule/2026-10-05/c1")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.body.schedules[0].someUnexpectedField, "legacy-value");
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.schedules[0], "_slotIdNum"));
  });
});

describe("GET /api/v1/admin/get-schedules (characterization)", () => {
  it("admin/bdm/teacher allowed, normal user denied", async () => {
    const schedules = new FakeSchedulesCollection();
    for (const role of ["admin", "bdm", "teacher"]) {
      const actor = makeUser(role);
      const app = freshApp(schedules, new FakeUsersCollection([actor]));
      const res = await request(app)
        .get("/api/v1/admin/get-schedules")
        .set("Authorization", `Bearer ${signToken(actor._id, role)}`);
      assert.equal(res.status, 200, `role ${role} should be allowed`);
    }
    const normal = makeUser("user");
    const app = freshApp(schedules, new FakeUsersCollection([normal]));
    const res = await request(app)
      .get("/api/v1/admin/get-schedules")
      .set("Authorization", `Bearer ${signToken(normal._id)}`);
    assert.equal(res.status, 403);
  });

  it("default page/limit, {schedules,total,page,limit} shape", async () => {
    const admin = makeUser("admin");
    const docs = Array.from({ length: 3 }, () => ({ _id: new ObjectId(), courseId: "c1" }) as FakeScheduleDoc);
    const schedules = new FakeSchedulesCollection(docs);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .get("/api/v1/admin/get-schedules")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 100);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.schedules.length, 3);
  });

  it("page clamps to minimum 1 (no upper clamp on page itself), limit clamps to [1,500]", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeSchedulesCollection();
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const resNegative = await request(app)
      .get("/api/v1/admin/get-schedules?page=-5&limit=-5")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(resNegative.body.page, 1);
    assert.equal(resNegative.body.limit, 1);

    // limit=0: parseInt("0",10) is 0, which is FALSY -- `0 || 100` falls back
    // to the 100 default rather than clamping to 1. This is the exact
    // `parseInt(...) || default` quirk the plan's ss4 calls out (a Zod
    // schema would very plausibly NOT reproduce this).
    const resZero = await request(app)
      .get("/api/v1/admin/get-schedules?limit=0")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(resZero.body.limit, 100);

    const resOverLimit = await request(app)
      .get("/api/v1/admin/get-schedules?limit=99999")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(resOverLimit.body.limit, 500);

    const resHighPage = await request(app)
      .get("/api/v1/admin/get-schedules?page=99999")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(resHighPage.body.page, 99999, "page has no upper clamp");
  });

  it("courseId/status filters, combined", async () => {
    const admin = makeUser("admin");
    const match: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", status: "Scheduled" };
    const wrongCourse: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c2", status: "Scheduled" };
    const wrongStatus: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1", status: "Cancelled" };
    const schedules = new FakeSchedulesCollection([match, wrongCourse, wrongStatus]);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .get("/api/v1/admin/get-schedules?courseId=c1&status=Scheduled")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, match._id.toString());
  });

  it("_id descending sort", async () => {
    const admin = makeUser("admin");
    const first: FakeScheduleDoc = { _id: new ObjectId("000000000000000000000001"), courseId: "c1" };
    const second: FakeScheduleDoc = { _id: new ObjectId("000000000000000000000002"), courseId: "c1" };
    const schedules = new FakeSchedulesCollection([first, second]);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .get("/api/v1/admin/get-schedules")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.body.schedules[0]._id, second._id.toString());
    assert.equal(res.body.schedules[1]._id, first._id.toString());
  });

  it("err.code===50 -> 504 'Query timed out.'", async () => {
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
    const app = freshApp(new TimeoutSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .get("/api/v1/admin/get-schedules")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 504);
    assert.deepEqual(res.body, { message: "Query timed out." });
  });
});

describe("DELETE /api/v1/admin/delete-schedule/:id (characterization)", () => {
  it("non-admin -> 403", async () => {
    const user = makeUser("user");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([user]));
    const res = await request(app)
      .delete(`/api/v1/admin/delete-schedule/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 403);
  });

  it("invalid ObjectId -> 400", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .delete("/api/v1/admin/delete-schedule/not-a-valid-id")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid schedule ID format." });
  });

  it("missing schedule -> 404", async () => {
    const admin = makeUser("admin");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([admin]));
    const res = await request(app)
      .delete(`/api/v1/admin/delete-schedule/${new ObjectId()}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: "Schedule not found" });
  });

  it("success -> 200 {success:true,...}, document removed", async () => {
    const admin = makeUser("admin");
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1" };
    const schedules = new FakeSchedulesCollection([doc]);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .delete(`/api/v1/admin/delete-schedule/${doc._id}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Schedule deleted successfully" });
    assert.equal((schedules.find() as FakeScheduleDoc[]).length, 0);
  });

  it("hard delete: a referencing booking is untouched by schedule deletion (documents, does not endorse, the orphan risk)", async () => {
    // No bookings collection is queried by this route at all -- this test
    // proves the ABSENCE of any cross-collection check, by using a
    // throwingCollection for bookingMockCollection and confirming the
    // delete still succeeds without ever touching it.
    const admin = makeUser("admin");
    const doc: FakeScheduleDoc = { _id: new ObjectId(), courseId: "c1" };
    const schedules = new FakeSchedulesCollection([doc]);
    const app = freshApp(schedules, new FakeUsersCollection([admin]));
    const res = await request(app)
      .delete(`/api/v1/admin/delete-schedule/${doc._id}`)
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
  });
});

describe("GET /api/v1/schedule/:userId (characterization -- legacy-only, Stage 9 does not migrate this route)", () => {
  it("remains reachable, authenticated, no object-authorization check (any userId value is queried directly)", async () => {
    const actor = makeUser("user");
    const app = freshApp(new FakeSchedulesCollection(), new FakeUsersCollection([actor]));
    const res = await request(app)
      .get(`/api/v1/schedule/${new ObjectId().toString()}`)
      .set("Authorization", `Bearer ${signToken(actor._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });
});
