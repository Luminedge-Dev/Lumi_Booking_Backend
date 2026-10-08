// Proves the native TypeScript Schedule module (src/app/modules/schedule,
// mounted by src/app.ts) keeps the HTTP contract locked in
// tests/characterization/schedule.contract.test.ts for the 4 migrated routes,
// the monthly route's full contract, the mandatory route-order guard, and
// GET /schedule/:userId's self-or-staff authorization (Stage 12.5).
//
// Stage 15: persistence moved from MongoDB to PostgreSQL/Prisma behind the
// ScheduleRepository port. These tests run against an in-memory fake of that
// port (everything ABOVE the repository). PostgreSQL behavior is proven in
// tests/postgres/schedule-repository.postgres.ts and Mongo-vs-PostgreSQL
// equivalence in tests/parity/schedule.parity.ts.
//
// Native-auth tests sign tokens against fakeAuthConfig() below.
// process.env.JWT_SECRET is ALSO set because the still-mounted legacy
// routers' middleware/auth.js verifyToken reads it directly.
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
import { FakeScheduleRepository, fakeCoreRepositories, scheduleRecord } from "../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../helpers/fake-users-repositories";
import { newObjectIdHex } from "../../src/app/shared/utils/object-id";
import { ScheduleQueryTimeoutError } from "../../src/app/modules/schedule/schedule.types";

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

function appWith(usersCollection: FakeUsersCollection, schedules: FakeScheduleRepository) {
  const dependencies: AppDependencies = {
    usersCollection: usersCollection as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, {
    corsOrigins: ["http://localhost:3000"],
    trustProxyHops: 1,
    authConfig: fakeAuthConfig(),
    repositories: fakeCoreRepositories({ ...usersBackedRepositories(usersCollection), schedule: schedules }),
  });
}

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}@example.test`, password: "x", role };
}

const COURSE = newObjectIdHex();

function createRow(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    testType: "Computer-Based",
    timeSlots: [{ startTime: "09:00", endTime: "10:00" }],
    ...overrides,
  };
}

describe("native Schedule module parity: POST /api/v1/admin/create-schedule", () => {
  it("non-admin -> 403, identical to legacy", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(user._id)}`)
      .send([]);
    assert.equal(res.status, 403);
  });

  it("single valid row -> 201, identical shape to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow()]);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Schedules created successfully.");
    assert.equal(res.body.successfulSchedules[0].assignedSlotId, "1");
  });

  it("mixed valid+invalid -> 207, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow(), { startDate: "2026-10-06" }]);
    assert.equal(res.status, 207);
  });

  it("non-array body -> 409, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send({ notAnArray: true });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { success: false, message: "No schedules created.", successfulSchedules: [], failedSchedules: [] });
  });

  it("unexpected mid-batch failure -> 500, earlier insert remains persisted (no rollback), identical to legacy", async () => {
    const admin = makeUser("admin");
    class ThrowingSecondInsert extends FakeScheduleRepository {
      private count = 0;
      async insertSchedule(doc: Parameters<FakeScheduleRepository["insertSchedule"]>[0]): Promise<void> {
        this.count += 1;
        if (this.count === 2) throw new Error("simulated failure");
        return super.insertSchedule(doc);
      }
    }
    const schedules = new ThrowingSecondInsert();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow(), createRow({ courseId: newObjectIdHex(), startDate: "2026-10-06", endDate: "2026-10-06" })]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    assert.equal(schedules.records.length, 1);
  });

  it("falsy-non-nullish courseId (0) in failedSchedules[] uses || semantics, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
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

  it("timeSlots:[false] normalizes without throwing, identical to legacy", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeScheduleRepository();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow({ timeSlots: [false] })]);
    assert.equal(res.status, 201);
    const slot = (schedules.records[0].timeSlots as Array<Record<string, unknown>>)[0];
    assert.equal(slot.startTime, "00:00:00");
    assert.equal(slot.endTime, "00:00:00");
    assert.strictEqual(slot.slot, 0);
    assert.strictEqual(slot.totalSlot, 0);
  });

  it("timeSlots:[null] -> 500, nothing persisted, identical to legacy", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeScheduleRepository();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow({ timeSlots: [null] })]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
    assert.equal(schedules.records.length, 0);
  });

  it("startTime:false normalizes to the same value legacy produces (String(v || \"\"), not String(v ?? \"\"))", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeScheduleRepository();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow({ timeSlots: [{ startTime: false, endTime: "10:00" }] })]);
    const slot = (schedules.records[0].timeSlots as Array<Record<string, unknown>>)[0];
    assert.equal(slot.startTime, "00:00:00");
    assert.equal(slot.endTime, "10:00:00");
  });

  it("an allocator read failure -> 500 with the exact legacy body", async () => {
    const admin = makeUser("admin");
    class ThrowingMax extends FakeScheduleRepository {
      async findMaxSlotId(): Promise<number> {
        throw new Error("simulated max-slot-ID query failure");
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new ThrowingMax());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow()]);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: "Server error while creating schedules" });
  });

  it("EXPECTED INTENTIONAL (Stage 15): a value PostgreSQL cannot store is a per-entry failure, never a 500", async () => {
    const admin = makeUser("admin");
    const schedules = new FakeScheduleRepository();
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow({ testType: undefined })]);
    assert.equal(res.status, 409);
    assert.equal(res.body.failedSchedules[0].message, "testType must be Computer-Based or Paper-Based");
    assert.equal(schedules.records.length, 0);
  });

  it("a persistence error never leaks Prisma/SQL detail in the 500 body", async () => {
    const admin = makeUser("admin");
    class Leaky extends FakeScheduleRepository {
      async insertSchedule(): Promise<void> {
        throw new Error('Invalid `prisma.schedule.create()` invocation: relation "schedules" violates constraint "pk"');
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new Leaky());
    const res = await request(app)
      .post("/api/v1/admin/create-schedule")
      .set("Authorization", `Bearer ${signToken(admin._id, "admin")}`)
      .send([createRow()]);
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|constraint|violates|invocation/i);
  });
});

describe("native Schedule module parity: GET /api/v1/schedule/:date/:courseId", () => {
  it("authenticated, exact match, identical to legacy", async () => {
    const user = makeUser("user");
    const doc = scheduleRecord({ courseId: COURSE });
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository([doc]));
    const res = await request(app).get(`/api/v1/schedule/2026-10-05/${COURSE}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, doc._id);
  });

  it("Cancelled excluded, identical to legacy", async () => {
    const user = makeUser("user");
    const cancelled = scheduleRecord({ courseId: COURSE, status: "Cancelled" });
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository([cancelled]));
    const res = await request(app).get(`/api/v1/schedule/2026-10-05/${COURSE}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("numeric slotId sort preserved: '2' before '10'", async () => {
    const user = makeUser("user");
    const slotTen = scheduleRecord({ courseId: COURSE, timeSlots: [{ slotId: "10" }] });
    const slotTwo = scheduleRecord({ courseId: COURSE, timeSlots: [{ slotId: "2" }] });
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository([slotTen, slotTwo]));
    const res = await request(app).get(`/api/v1/schedule/2026-10-05/${COURSE}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.body.schedules[0]._id, slotTwo._id);
    assert.equal(res.body.schedules[1]._id, slotTen._id);
  });

  it("no token -> 401, never a misleading 400/403", async () => {
    const app = appWith(new FakeUsersCollection(), new FakeScheduleRepository());
    const res = await request(app).get(`/api/v1/schedule/2026-10-05/${COURSE}`);
    assert.equal(res.status, 401);
  });

  it("a read failure -> 500 with the exact legacy body", async () => {
    const user = makeUser("user");
    class Failing extends FakeScheduleRepository {
      async findByDateAndCourse(): Promise<never> {
        throw new Error("simulated read failure");
      }
    }
    const app = appWith(new FakeUsersCollection([user]), new Failing());
    const res = await request(app).get(`/api/v1/schedule/2026-10-05/${COURSE}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "Failed to load schedules" });
  });
});

describe("native Schedule module parity: GET /api/v1/admin/get-schedules", () => {
  it("admin/bdm/teacher allowed, normal user denied, identical to legacy", async () => {
    const schedules = new FakeScheduleRepository();
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
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository([scheduleRecord(), scheduleRecord(), scheduleRecord()]));
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 100);
  });

  it("504 timeout preservation: ScheduleQueryTimeoutError -> 'Query timed out.', identical to legacy", async () => {
    const admin = makeUser("admin");
    class Timeout extends FakeScheduleRepository {
      async countAdmin(): Promise<never> {
        throw new ScheduleQueryTimeoutError();
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new Timeout());
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 504);
    assert.deepEqual(res.body, { message: "Query timed out." });
  });

  it("a non-timeout persistence failure is not a 504", async () => {
    const admin = makeUser("admin");
    class Failing extends FakeScheduleRepository {
      async listAdmin(): Promise<never> {
        throw new Error("simulated failure");
      }
    }
    const app = appWith(new FakeUsersCollection([admin]), new Failing());
    const res = await request(app).get("/api/v1/admin/get-schedules").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.notEqual(res.status, 504);
    assert.equal(res.status, 500);
  });
});

describe("native Schedule module parity: DELETE /api/v1/admin/delete-schedule/:id", () => {
  it("success -> 200, document removed, identical to legacy", async () => {
    const admin = makeUser("admin");
    const doc = scheduleRecord();
    const schedules = new FakeScheduleRepository([doc]);
    const app = appWith(new FakeUsersCollection([admin]), schedules);
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${doc._id}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: "Schedule deleted successfully" });
    assert.equal(schedules.records.length, 0);
  });

  it("invalid ObjectId -> 400, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
    const res = await request(app).delete("/api/v1/admin/delete-schedule/not-a-valid-id").set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid schedule ID format." });
  });

  it("missing schedule -> 404, identical to legacy", async () => {
    const admin = makeUser("admin");
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository());
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${new ObjectId()}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 404);
  });

  it("HARD DELETE PRESERVED: no booking lookup is introduced (bookingMockCollection is a throwing collection and is never touched)", async () => {
    const admin = makeUser("admin");
    const doc = scheduleRecord();
    const app = appWith(new FakeUsersCollection([admin]), new FakeScheduleRepository([doc]));
    const res = await request(app).delete(`/api/v1/admin/delete-schedule/${doc._id}`).set("Authorization", `Bearer ${signToken(admin._id, "admin")}`);
    assert.equal(res.status, 200);
  });
});

describe("native Schedule module: GET /api/v1/schedule/course/:courseId?month=YYYY-MM contract", () => {
  it("no token -> 401", async () => {
    const app = appWith(new FakeUsersCollection(), new FakeScheduleRepository());
    const res = await request(app).get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-10`);
    assert.equal(res.status, 401);
  });

  it("missing month -> 400 {message:'Invalid month. Expected YYYY-MM.'}", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app).get(`/api/v1/schedule/course/${new ObjectId()}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid month. Expected YYYY-MM." });
  });

  it("invalid month -> 400", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app)
      .get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-13`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
  });

  it("invalid courseId -> 400 {message:'Invalid course ID.'}", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app)
      .get("/api/v1/schedule/course/not-a-valid-id?month=2026-10")
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid course ID." });
  });

  it("valid request: only the requested course, only the requested month, Cancelled excluded", async () => {
    const user = makeUser("user");
    const courseId = newObjectIdHex();
    const inMonth = scheduleRecord({ courseId, startDate: "2026-10-15" });
    const outOfMonth = scheduleRecord({ courseId, startDate: "2026-11-01" });
    const cancelled = scheduleRecord({ courseId, startDate: "2026-10-20", status: "Cancelled" });
    const otherCourse = scheduleRecord({ courseId: newObjectIdHex(), startDate: "2026-10-15" });
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository([inMonth, outOfMonth, cancelled, otherCourse]));
    const res = await request(app).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0]._id, inMonth._id);
  });

  it("no matches -> 200 {schedules:[]}, not 404", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app)
      .get(`/api/v1/schedule/course/${new ObjectId()}?month=2026-10`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("MANDATORY ROUTE-ORDER GATE: /schedule/course/:courseId is never captured by the generic /schedule/:date/:courseId pattern", async () => {
    const user = makeUser("user");
    const courseId = newObjectIdHex();
    const doc = scheduleRecord({ courseId, startDate: "2026-10-15" });
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository([doc]));
    const res = await request(app).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
  });
});

describe("GET /api/v1/schedule/:userId (Stage 12.5 MIGRATED + SECURED)", () => {
  it("cross-user read is forbidden natively (was 200 [] through legacy)", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app).get(`/api/v1/schedule/${new ObjectId().toString()}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden" });
  });

  it("self read keeps the legacy empty shape", async () => {
    const user = makeUser("user");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());
    const res = await request(app).get(`/api/v1/schedule/${user._id.toString()}`).set("Authorization", `Bearer ${signToken(user._id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });
});
