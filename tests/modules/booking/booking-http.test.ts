// Stage 16 booking module: HTTP contract through the real TS composition root
// with the real native auth boundary, a scripted in-memory BookingRepository
// and a recording notifier. No Mongo, no PostgreSQL, no e-mail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../../src/app";
import type { AppDependencies } from "../../../src/app/database/database.types";
import type { AuthConfig } from "../../../src/app/modules/auth/auth.types";
import type { BookingRepository } from "../../../src/app/modules/booking/booking.repository";
import { BookingService, type BookingNotifier } from "../../../src/app/modules/booking/booking.service";
import { PersistenceError } from "../../../src/app/database/persistence-error";
import { BookingQueryTimeoutError } from "../../../src/app/modules/booking/booking.types";
import type {
  AssignTeacherOutcome, AttendanceOutcome, BookOutcome, BookingUserContext, CancelOutcome, ScheduleSlotContext,
} from "../../../src/app/modules/booking/booking.types";
import { fakeCoreRepositories } from "../../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../../helpers/fake-users-repositories";
import { throwingCollection } from "../../helpers/create-test-app";
import { FakeUsersCollection } from "../../helpers/fake-users-collection";

process.env.JWT_SECRET = "test-only-secret";

const authConfig: AuthConfig = {
  jwtSecret: "test-only-secret",
  jwtResetPasswordSecret: "test-only-reset-secret",
  jwtExpiresIn: "7d",
  jwtResetPasswordTokenExpiresIn: "15m",
  resetPasswordLink: "https://example.test/reset-password",
  isProduction: false,
};

type Script = {
  user?: BookingUserContext | null;
  usage?: { purchased: number; used: number };
  homeSystems?: string[] | null;
  schedule?: ScheduleSlotContext | null;
  home?: BookOutcome | Error;
  center?: BookOutcome | Error;
  cancel?: CancelOutcome;
  assign?: AssignTeacherOutcome;
  attendance?: AttendanceOutcome;
  adminList?: Array<Record<string, unknown>> | Error;
};

class ScriptedBookingRepository implements BookingRepository {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(private readonly script: Script = {}, private readonly log: string[] = []) {}
  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    this.log.push(`repo:${method}`);
  }
  async findUserContext(userId: string) { this.rec("findUserContext", userId); return this.script.user === undefined ? { id: userId, name: "Stu", email: "stu@example.test", mock: 2, mockType: "IELTS", testType: "Computer-Based" } : this.script.user; }
  async entitlementUsage(userId: string, policy: unknown) { this.rec("entitlementUsage", userId, policy); return this.script.usage ?? { purchased: 0, used: 0 }; }
  async findHomeSystems(course: string) { this.rec("findHomeSystems", course); return this.script.homeSystems === undefined ? null : this.script.homeSystems; }
  async findScheduleSlot(scheduleId: string, slotId: string) {
    this.rec("findScheduleSlot", scheduleId, slotId);
    return this.script.schedule === undefined ? { scheduleId, startDate: "2031-02-03", slot: { slotId, seatsLeft: 3, startTime: "09:00", endTime: "10:00" } } : this.script.schedule;
  }
  async createHomeBooking(command: { bookingId: string; userId: string; name: string; testType: "Computer-Based" | "Paper-Based"; testSystem: string; bookingDate: string; testTime: string }) {
    this.rec("createHomeBooking", command);
    if (this.script.home instanceof Error) throw this.script.home;
    return this.script.home ?? ({ kind: "booked", booking: { _id: command.bookingId, userId: command.userId, name: command.name, location: "Home", bookingDate: command.bookingDate, status: "pending", testType: command.testType, testSystem: command.testSystem, testTime: command.testTime } } as BookOutcome);
  }
  async createTestCenterBooking(command: { bookingId: string; userId: string; scheduleId: string; slotId: string; name: string; testType: "Computer-Based" | "Paper-Based"; testSystem: string | null; bookingDate: string; startTime: string; endTime: string }) {
    this.rec("createTestCenterBooking", command);
    if (this.script.center instanceof Error) throw this.script.center;
    return this.script.center ?? ({ kind: "booked", booking: { _id: command.bookingId, userId: command.userId, scheduleId: command.scheduleId, slotId: command.slotId, name: command.name, location: "Test Center", bookingDate: command.bookingDate, status: "pending", testType: command.testType, testSystem: command.testSystem, startTime: command.startTime, endTime: command.endTime } } as BookOutcome);
  }
  async findBookingRef() { return null; }
  async cancelBooking(command: unknown) { this.rec("cancelBooking", command); return this.script.cancel ?? ({ kind: "cancelled" } as CancelOutcome); }
  async assignTeacher(command: unknown) {
    this.rec("assignTeacher", command);
    return this.script.assign ?? ({ kind: "assigned", booking: { _id: "b", userId: "u", name: "IELTS", location: "Home", bookingDate: "2031-01-01", status: "pending", testType: "Computer-Based", teacherL: "T", teacherLEmail: "t@example.test" } } as AssignTeacherOutcome);
  }
  async listByUser(userId: string) { this.rec("listByUser", userId); return [{ _id: "x" }]; }
  async listAdmin() {
    this.rec("listAdmin");
    if (this.script.adminList instanceof Error) throw this.script.adminList;
    return (this.script.adminList ?? [{ _id: "x" }]) as never;
  }
  async countAdmin() { this.rec("countAdmin"); return 7; }
  async listBySchedule() { this.rec("listBySchedule"); return []; }
  async listHomeWithUsers() { this.rec("listHomeWithUsers"); return []; }
  async attendanceCounts(ids: string[]) { this.rec("attendanceCounts", ids); return {}; }
  async updateAttendance(target: unknown, values: unknown) { this.rec("updateAttendance", target, values); return this.script.attendance ?? ({ kind: "updated" } as AttendanceOutcome); }
}

function recordingNotifier(log: string[], throws = false): BookingNotifier & { confirmed: number; attendance: Array<[string, string]> } {
  const n = {
    confirmed: 0,
    attendance: [] as Array<[string, string]>,
    bookingConfirmed() { log.push("notify:confirmed"); n.confirmed += 1; if (throws) throw new Error("smtp down"); },
    attendanceRecorded(_user: unknown, attendance: string, date: string) { log.push("notify:attendance"); n.attendance.push([attendance, date]); },
  };
  return n;
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}-${new ObjectId().toHexString()}@example.test`, password: "x", role };
}
const tokenFor = (user: { _id: ObjectId; role: string; email: string }) =>
  jwt.sign({ userId: user._id.toString(), email: user.email, role: user.role }, "test-only-secret");

function appWith(users: ReturnType<typeof makeUser>[], repo: BookingRepository, notifier: BookingNotifier) {
  const usersCollection = new FakeUsersCollection(users);
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
    authConfig,
    repositories: fakeCoreRepositories({ ...usersBackedRepositories(usersCollection), booking: repo }),
    bookingNotifier: notifier,
  });
}

const homeBody = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, location: "Home", name: "IELTS", testType: "Computer-Based", testSystem: "Computer-Based",
  bookingDate: "2031-03-01", testTime: "10:30", status: "pending", ...extra,
});

describe("POST /api/v1/user/book-slot (native, PostgreSQL-backed)", () => {
  it("Home: legacy success body, mock/credit work delegated, notification only AFTER the repository commit", async () => {
    const log: string[] = [];
    const user = makeUser();
    const repo = new ScriptedBookingRepository({}, log);
    const notifier = recordingNotifier(log);
    const res = await request(appWith([user], repo, notifier)).post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Home test booked successfully");
    assert.equal(res.body.bookingRecord.status, "pending");
    assert.equal(res.body.bookingRecord.location, "Home");
    assert.equal(res.body.bookingRecord.bookingDate, "2031-03-01");
    assert.match(res.body.bookingRecord._id, /^[0-9a-f]{24}$/);
    assert.ok(log.indexOf("notify:confirmed") > log.indexOf("repo:createHomeBooking"), JSON.stringify(log));
  });

  it("a notifier failure never changes the committed booking response", async () => {
    const log: string[] = [];
    const user = makeUser();
    const res = await request(appWith([user], new ScriptedBookingRepository({}, log), recordingNotifier(log, true)))
      .post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it("rejected bookings never notify", async () => {
    const log: string[] = [];
    const user = makeUser();
    const notifier = recordingNotifier(log);
    const res = await request(appWith([user], new ScriptedBookingRepository({ home: { kind: "duplicate" } }, log), notifier))
      .post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "You already have a test booked for this date.");
    assert.equal(notifier.confirmed, 0);
  });

  it("authority comes from the token: booking for another user is 403, admin may book for anyone; anonymous is 401", async () => {
    const user = makeUser();
    const other = makeUser();
    const admin = makeUser("admin");
    const repo = new ScriptedBookingRepository();
    const app = appWith([user, other, admin], repo, recordingNotifier([]));
    const spoof = await request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(other._id.toString()));
    assert.equal(spoof.status, 403);
    assert.deepEqual(spoof.body, { message: "Forbidden" });
    assert.equal(repo.calls.filter((c) => c.method.startsWith("create")).length, 0);
    const adminRes = await request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(admin)}`).send(homeBody(other._id.toString()));
    assert.equal(adminRes.status, 200);
    assert.equal((await request(app).post("/api/v1/user/book-slot").send(homeBody(user._id.toString()))).status, 401);
  });

  it("legacy validation messages are preserved verbatim", async () => {
    const user = makeUser();
    const app = appWith([user], new ScriptedBookingRepository(), recordingNotifier([]));
    const post = (body: Record<string, unknown>) => request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(body);
    assert.equal((await post({ location: "Home" })).body.message, "Missing required fields. 'userId' and 'location' are required.");
    assert.equal((await post({ userId: "zzz", location: "Home" })).body.message, "Invalid user ID format.");
    assert.equal((await post({ userId: user._id.toString(), location: "Mars" })).body.message, "Invalid location type. Must be 'Home' or 'Test Center'.");
    assert.equal((await post(homeBody(user._id.toString(), { bookingDate: "" }))).body.message, "Please select a booking date and test time.");
  });

  it("insufficient credit uses the substring the reschedule flow keys on", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository({ user: { id: user._id.toString(), name: "S", email: "s@example.test", mock: 0, mockType: null, testType: null } });
    const res = await request(appWith([user], repo, recordingNotifier([]))).post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Insufficient mock/);
  });

  it("entitlement exhaustion is rejected before any write (purchased > 0 and used >= purchased)", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository({ usage: { purchased: 2, used: 2 } });
    const res = await request(appWith([user], repo, recordingNotifier([]))).post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Insufficient mock/);
    assert.equal(repo.calls.some((c) => c.method === "createHomeBooking"), false);
  });

  it("persistence-forced 400s (A1): impossible calendar date, timestamp string, and unknown test type", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository();
    const app = appWith([user], repo, recordingNotifier([]));
    const post = (extra: Record<string, unknown>) => request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString(), extra));
    assert.equal((await post({ bookingDate: "2031-02-30" })).status, 400);
    assert.equal((await post({ bookingDate: "2031-03-01T00:00:00Z" })).status, 400);
    assert.equal((await post({ bookingDate: "03/01/2031" })).status, 400);
    assert.equal((await post({ testType: "Unknown", testSystem: "Computer-Based" })).status, 400);
    assert.equal(repo.calls.some((c) => c.method === "createHomeBooking"), false);
    const ok = await post({ bookingDate: "2032-02-29" }); // real leap day
    assert.equal(ok.status, 200);
    assert.equal(ok.body.bookingRecord.bookingDate, "2032-02-29", "no timezone shift");
  });

  it("Home eligibility: a course with an empty homeBasedSystems list blocks Home and creates nothing", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository({ homeSystems: [] });
    const res = await request(appWith([user], repo, recordingNotifier([]))).post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${tokenFor(user)}`).send(homeBody(user._id.toString()));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not available for Home-based mock tests/);
    assert.equal(repo.calls.some((c) => c.method === "createHomeBooking"), false);
  });

  it("Test Center: booking date comes from the schedule, not the body; testSystem null is preserved", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository();
    const scheduleId = new ObjectId().toHexString();
    const res = await request(appWith([user], repo, recordingNotifier([]))).post("/api/v1/user/book-slot")
      .set("Authorization", `Bearer ${tokenFor(user)}`)
      .send({ userId: user._id.toString(), location: "Test Center", scheduleId, slotId: "1", testType: "Computer-Based", name: "IELTS", bookingDate: "1999-01-01" });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "Test Center test booked successfully");
    assert.equal(res.body.bookingRecord.bookingDate, "2031-02-03");
    assert.equal(res.body.bookingRecord.testSystem, null);
    assert.equal(res.body.bookingRecord.startTime, "09:00");
  });

  it("Test Center failures: missing schedule 404, no seat 400, slot taken 400, exhausted serialization retries 409 (A2)", async () => {
    const user = makeUser();
    const scheduleId = new ObjectId().toHexString();
    const body = { userId: user._id.toString(), location: "Test Center", scheduleId, slotId: "1", testType: "Computer-Based", name: "IELTS" };
    const run = async (script: Script) => {
      const app = appWith([user], new ScriptedBookingRepository(script), recordingNotifier([]));
      return request(app).post("/api/v1/user/book-slot").set("Authorization", `Bearer ${tokenFor(user)}`).send(body);
    };
    assert.equal((await run({ schedule: null })).status, 404);
    const noSeat = await run({ schedule: { scheduleId, startDate: "2031-02-03", slot: { slotId: "1", seatsLeft: 0, startTime: "09:00", endTime: "10:00" } } });
    assert.equal(noSeat.status, 400);
    assert.equal(noSeat.body.message, "Invalid or unavailable time slot selected.");
    const taken = await run({ center: { kind: "slot_taken" } });
    assert.equal(taken.status, 400);
    assert.equal(taken.body.message, "This time slot was just taken. Please pick another.");
    assert.equal((await run({ center: { kind: "duplicate" } })).body.message, "You have already booked a slot for this date.");
    const conflict = await run({ center: new PersistenceError("UNEXPECTED", "booking.create_test_center", "P2034", true) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.message, "This time slot was just taken. Please pick another.");
    const other = await run({ center: new PersistenceError("UNEXPECTED", "booking.create_test_center", "P2002", false) });
    assert.equal(other.status, 500);
    assert.deepEqual(other.body, { success: false, message: "Internal server error" });
  });
});

describe("DELETE /api/v1/bookings/:bookingId", () => {
  it("maps outcomes to the legacy contract; the actor comes from the token", async () => {
    const user = makeUser();
    const admin = makeUser("admin");
    const id = new ObjectId().toHexString();
    const run = async (cancel: CancelOutcome, actor = user) => {
      const repo = new ScriptedBookingRepository({ cancel });
      const res = await request(appWith([user, admin], repo, recordingNotifier([]))).delete(`/api/v1/bookings/${id}`).set("Authorization", `Bearer ${tokenFor(actor)}`);
      return { res, repo };
    };
    const ok = await run({ kind: "cancelled" });
    assert.equal(ok.res.status, 200);
    assert.deepEqual(ok.res.body, { success: true, message: "Booking canceled successfully, and mock count restored" });
    assert.deepEqual(ok.repo.calls[0]!.args[0], { bookingId: id, actorUserId: user._id.toString(), actorIsAdmin: false });
    assert.equal(((await run({ kind: "cancelled" }, admin)).repo.calls[0]!.args[0] as { actorIsAdmin: boolean }).actorIsAdmin, true);
    assert.deepEqual((await run({ kind: "not_found" })).res.body, { message: "Booking not found." });
    assert.equal((await run({ kind: "not_found" })).res.status, 404);
    assert.equal((await run({ kind: "forbidden" })).res.status, 403);
    const restore = await run({ kind: "credit_restore_failed" });
    assert.equal(restore.res.status, 500);
    assert.deepEqual(restore.res.body, { message: "Failed to update mock count." });
    const bad = await request(appWith([user], new ScriptedBookingRepository(), recordingNotifier([]))).delete("/api/v1/bookings/not-an-id").set("Authorization", `Bearer ${tokenFor(user)}`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, "Invalid booking ID format.");
  });
});

describe("reads, attendance and teacher assignment", () => {
  it("GET /user/bookings/:userId is self-or-staff", async () => {
    const user = makeUser();
    const other = makeUser();
    const teacher = makeUser("teacher");
    const app = appWith([user, other, teacher], new ScriptedBookingRepository(), recordingNotifier([]));
    const get = (actor: typeof user, target: ObjectId) => request(app).get(`/api/v1/user/bookings/${target}`).set("Authorization", `Bearer ${tokenFor(actor)}`);
    assert.equal((await get(user, user._id)).status, 200);
    assert.equal((await get(user, other._id)).status, 403);
    assert.equal((await get(teacher, other._id)).status, 200);
  });

  it("GET /admin/bookings: admin only, 404 when page 1 is empty, total only on page 1, timeout -> 504", async () => {
    const user = makeUser();
    const admin = makeUser("admin");
    const get = (script: Script, actor = admin, q = "") =>
      request(appWith([user, admin], new ScriptedBookingRepository(script), recordingNotifier([]))).get(`/api/v1/admin/bookings${q}`).set("Authorization", `Bearer ${tokenFor(actor)}`);
    assert.equal((await get({}, user)).status, 403);
    const page1 = await get({});
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 7);
    assert.equal(page1.body.page, 1);
    assert.equal(page1.body.limit, 500);
    assert.equal((await get({}, admin, "?page=2")).body.total, undefined);
    assert.deepEqual((await get({ adminList: [] })).body, { message: "No bookings found" });
    const slow = await get({ adminList: new BookingQueryTimeoutError() });
    assert.equal(slow.status, 504);
    assert.equal(slow.body.message, "Query took too long. Try a smaller page/limit.");
  });

  it("POST /user/attendance/bulk validates userIds with the legacy body", async () => {
    const teacher = makeUser("teacher");
    const user = makeUser();
    const app = appWith([teacher, user], new ScriptedBookingRepository(), recordingNotifier([]));
    const bad = await request(app).post("/api/v1/user/attendance/bulk").set("Authorization", `Bearer ${tokenFor(teacher)}`).send({});
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: "Invalid userIds format" });
    assert.equal((await request(app).post("/api/v1/user/attendance/bulk").set("Authorization", `Bearer ${tokenFor(teacher)}`).send({ userIds: ["a"] })).status, 200);
    assert.equal((await request(app).post("/api/v1/user/attendance/bulk").set("Authorization", `Bearer ${tokenFor(user)}`).send({ userIds: ["a"] })).status, 403);
  });

  it("PUT /user/bookings/:scheduleId: validation, unchanged short-circuit, and e-mail intent only after the update", async () => {
    const admin = makeUser("admin");
    const student = makeUser();
    const log: string[] = [];
    const notifier = recordingNotifier(log);
    const put = (script: Script, id: string, body: Record<string, unknown>) =>
      request(appWith([admin, student], new ScriptedBookingRepository(script, log), notifier)).put(`/api/v1/user/bookings/${id}`).set("Authorization", `Bearer ${tokenFor(admin)}`).send(body);
    const sid = student._id.toString();
    assert.equal((await put({}, "home", { userId: sid })).body.message, "Missing required fields.");
    assert.equal((await put({}, "home", { userId: sid, attendance: "present", status: "Present" })).body.message, "Booking date is required for Home bookings.");
    assert.equal((await put({}, "home", { userId: sid, attendance: "present", status: "Present", bookingDate: "nope" })).body.message, "Invalid booking date format.");
    assert.equal((await put({}, "home", { userId: sid, attendance: "present", status: "Weird", bookingDate: "2031-01-02" })).status, 400);
    assert.equal((await put({}, "zzz", { userId: sid, attendance: "present", status: "Present" })).body.message, "Invalid schedule ID format.");
    assert.equal((await put({ attendance: { kind: "not_found" } }, "home", { userId: sid, attendance: "present", status: "Present", bookingDate: "2031-01-02" })).status, 404);

    const unchanged = await put({ attendance: { kind: "unchanged" } }, "home", { userId: sid, attendance: "present", status: "Present", bookingDate: "2031-01-02" });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.body, { message: "Attendance already updated." });
    assert.equal(notifier.attendance.length, 0);

    log.length = 0;
    const updated = await put({}, "home", { userId: sid, attendance: "absent", status: "Absent", bookingDate: "2031-01-02" });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, { success: true, message: "Attendance updated successfully for Home booking." });
    assert.deepEqual(notifier.attendance[0], ["absent", "January 2, 2031"]);
    assert.ok(log.indexOf("notify:attendance") > log.indexOf("repo:updateAttendance"));
  });

  it("PUT /admin/bookings/:bookingId/teacher: admin only, validation order and messages, normalized e-mail, 404 for non-Home", async () => {
    const admin = makeUser("admin");
    const teacher = makeUser("teacher");
    const id = new ObjectId().toHexString();
    const repoFor = (script: Script = {}) => new ScriptedBookingRepository(script);
    const put = (repo: ScriptedBookingRepository, actor: typeof admin, bookingId: string, body: Record<string, unknown>) =>
      request(appWith([admin, teacher], repo, recordingNotifier([]))).put(`/api/v1/admin/bookings/${bookingId}/teacher`).set("Authorization", `Bearer ${tokenFor(actor)}`).send(body);
    assert.equal((await put(repoFor(), teacher, id, { skill: "L", teacher: "T", email: "t@example.test" })).status, 403);
    assert.equal((await put(repoFor(), admin, "nope", { skill: "L", teacher: "T", email: "e" })).body.message, "Invalid booking ID.");
    assert.equal((await put(repoFor(), admin, id, { skill: "X", teacher: "T", email: "e" })).body.message, "Invalid skill parameter");
    assert.equal((await put(repoFor(), admin, id, { skill: "L", teacher: "", email: "e" })).body.message, "Teacher and email are required");

    const repo = repoFor();
    const ok = await put(repo, admin, id, { skill: "R", teacher: "Ms Lee", email: "  LEE@Example.Test " });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.message, "Teacher for R updated for home booking");
    assert.ok(ok.body.booking._id);
    assert.deepEqual(repo.calls[0]!.args[0], { bookingId: id, skill: "R", teacher: "Ms Lee", email: "lee@example.test" });

    const missing = await put(repoFor({ assign: { kind: "not_found" } }), admin, id, { skill: "L", teacher: "T", email: "t@example.test" });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: "Home booking not found" });
  });
});

describe("route ownership and boot composition", () => {
  it("native booking handles its paths; /send-reminder is still served by the legacy router; no Mongo collection is touched by native paths", async () => {
    const user = makeUser();
    const repo = new ScriptedBookingRepository();
    const app = appWith([user], repo, recordingNotifier([]));
    const native = await request(app).get(`/api/v1/user/bookings/${user._id}`).set("Authorization", `Bearer ${tokenFor(user)}`);
    assert.equal(native.status, 200);
    assert.equal(repo.calls[0]!.method, "listByUser");
    // Legacy-only route: anonymous reaches legacy auth (401), it is not a native 404.
    const reminder = await request(app).post("/api/v1/send-reminder").send({ emails: [] });
    assert.equal(reminder.status, 401);
  });

  it("the service is usable without Express (no req/res dependency)", async () => {
    const service = new BookingService(new ScriptedBookingRepository(), recordingNotifier([]));
    const result = await service.cancel({ userId: new ObjectId().toHexString(), role: "user" }, new ObjectId().toHexString());
    assert.equal(result.success, true);
  });
});
