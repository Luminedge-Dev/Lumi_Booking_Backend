"use strict";

/** FIX-07 acceptance tests. All writes target a fresh disposable local replica set. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const {
  resolveTestMongoUri,
  disposableDbName,
  stripInheritedMongoEnv,
  connectDisposable,
} = require("../support/hotfixTestDb");

const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("fix07freeze");
const previousEnv = Object.hasOwn(process.env, "BOOKING_FROZEN")
  ? process.env.BOOKING_FROZEN
  : undefined;
delete process.env.BOOKING_FROZEN;
stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;
// No real SMTP can be configured or invoked by these synthetic fixtures.
for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_EMAIL", "SMTP_APP_PASS", "EMAIL", "APP_PASS"]) {
  delete process.env[key];
}

// Test-local limiter instrumentation makes precedence deterministic without
// changing the production threshold or issuing a request flood.
const rateLimitModule = require("../../middleware/rateLimit");
const realGlobalLimiter = rateLimitModule.globalLimiter;
let instrumentedLimiterCalls = 0;
rateLimitModule.globalLimiter = (req, res, next) => {
  instrumentedLimiterCalls += 1;
  if (req.headers["x-test-force-limit"] === "1") {
    return res.status(429).json({ code: "TEST_RATE_LIMITED" });
  }
  return realGlobalLimiter(req, res, next);
};
let createApp;
try {
  createApp = require("../../app");
} finally {
  rateLimitModule.globalLimiter = realGlobalLimiter;
}
const JWT_SECRET = process.env.JWT_SECRET;
const dhakaDateIn = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
const dhakaIsoIn = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

let client;
let db;
let users;
let bookings;
let schedules;
let courses;
let server;
let baseUrl;

const tokenFor = (user, role = user.role) =>
  jwt.sign({ userId: String(user._id), role, email: user.email }, JWT_SECRET, { expiresIn: "1h" });

async function api(method, path, { token, body, headers: extraHeaders = {} } = {}) {
  const headers = { "X-Forwarded-For": "127.0.0.1" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders);
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch {}
  return { status: response.status, body: parsed };
}

async function apiRaw(method, path, { body, headers: extraHeaders = {} } = {}) {
  const headers = { "X-Forwarded-For": "127.0.0.1", ...extraHeaders };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  let parsed = null;
  try { parsed = await response.json(); } catch {}
  return { status: response.status, body: parsed, headers: response.headers };
}

async function seedUser(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "Synthetic FIX-07 User",
    email: `fix07.${crypto.randomBytes(6).toString("hex")}@synthetic.invalid`,
    role: "user",
    status: "completed",
    isDeleted: false,
    mock: 0,
    totalMock: 0,
    ...overrides,
  };
  await users.insertOne(doc);
  return doc;
}

const adminUser = () => seedUser({ role: "admin", status: "active" });

function withFreeze(value, action) {
  const old = Object.hasOwn(process.env, "BOOKING_FROZEN") ? process.env.BOOKING_FROZEN : undefined;
  if (value === undefined) delete process.env.BOOKING_FROZEN;
  else process.env.BOOKING_FROZEN = value;
  return Promise.resolve().then(action).finally(() => {
    if (old === undefined) delete process.env.BOOKING_FROZEN;
    else process.env.BOOKING_FROZEN = old;
  });
}

before(async () => {
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));
  users = db.collection("users");
  bookings = db.collection("bookingMock");
  schedules = db.collection("schedules");
  courses = db.collection("courses");
  server = createApp({
    usersCollection: users,
    bookingMockCollection: bookings,
    schedulesCollection: schedules,
    coursesCollection: courses,
    reminderDeliveriesCollection: db.collection("reminderDeliveries"),
    client,
  }).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (previousEnv === undefined) delete process.env.BOOKING_FROZEN;
  else process.env.BOOKING_FROZEN = previousEnv;
});

test("F7-01..08: all three designated writes return the exact frozen response before auth or validation", async () => {
  await withFreeze("1", async () => {
    const cases = [
      api("POST", "/user/book-slot", { body: { malformed: true } }),
      api("POST", "/user/book-slot"),
      api("DELETE", "/bookings/not-an-object-id"),
      api("POST", "/admin/create-schedule", { body: { malformed: true } }),
    ];
    for (const result of await Promise.all(cases)) {
      assert.equal(result.status, 423);
      assert.deepEqual(result.body, {
        message: "Booking has moved to the Luminedge portal",
        code: "BOOKING_FROZEN",
      });
    }
  });
});

test("F7-09..13: frozen writes do not change credits, bookings, slots, or schedules", async () => {
  const student = await seedUser({ mock: 2, totalMock: 2 });
  const schedule = {
    _id: new ObjectId(),
    courseId: new ObjectId().toHexString(),
    startDate: dhakaDateIn(7), endDate: dhakaDateIn(7), status: "Scheduled",
    timeSlots: [{ slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 3, totalSlot: 3 }],
  };
  await schedules.insertOne(schedule);
  const booking = {
    _id: new ObjectId(), userId: String(student._id), scheduleId: String(schedule._id), slotId: "1",
    location: "Test Center", status: "pending", bookingDate: schedule.startDate,
  };
  await bookings.insertOne(booking);
  const beforeStudent = await users.findOne({ _id: student._id });
  const beforeBookingCount = await bookings.countDocuments({});
  const beforeSchedules = await schedules.countDocuments({});
  const beforeSlot = (await schedules.findOne({ _id: schedule._id })).timeSlots[0].slot;

  await withFreeze("1", async () => {
    assert.equal((await api("POST", "/user/book-slot", { token: tokenFor(student), body: {} })).status, 423);
    assert.equal((await api("DELETE", `/bookings/${booking._id}`, { token: tokenFor(await adminUser()) })).status, 423);
    assert.equal((await api("POST", "/admin/create-schedule", {
      token: tokenFor(await adminUser()), body: [{ courseId: "bad" }],
    })).status, 423);
  });

  assert.equal((await users.findOne({ _id: student._id })).mock, beforeStudent.mock);
  assert.equal(await bookings.countDocuments({}), beforeBookingCount);
  assert.equal((await bookings.findOne({ _id: booking._id })).status, "pending");
  assert.equal(await schedules.countDocuments({}), beforeSchedules);
  assert.equal((await schedules.findOne({ _id: schedule._id })).timeSlots[0].slot, beforeSlot);
});

test("F7-14..18: reads, attendance, feedback, and reminder routes are not globally frozen", async () => {
  const student = await seedUser();
  const admin = await adminUser();
  const scheduleId = new ObjectId().toHexString();
  const date = dhakaDateIn(3);
  await schedules.insertOne({
    _id: new ObjectId(scheduleId), courseId: new ObjectId().toHexString(),
    startDate: date, endDate: date, name: "Synthetic schedule", timeSlots: [],
  });
  await bookings.insertOne({
    _id: new ObjectId(), userId: String(student._id), scheduleId, status: "pending",
    location: "Home", bookingDate: date, name: "IELTS", testType: "Academic", testSystem: "Computer-Based",
  });
  await users.updateOne({ _id: student._id }, { $set: { teachersBySchedule: { [scheduleId]: { teacherLEmail: admin.email } } } });

  await withFreeze("1", async () => {
    assert.equal((await api("GET", "/courses")).status, 200);
    const history = await api("GET", `/user/bookings/${student._id}`, { token: tokenFor(student) });
    assert.equal(history.status, 200);
    assert.equal(history.body.bookings.length, 1);
    const attendance = await api("PUT", `/user/bookings/${scheduleId}`, {
      token: tokenFor(admin),
      body: { userId: String(student._id), attendance: "absent", status: "absent" },
    });
    assert.equal(attendance.status, 200);
    const feedback = await api("POST", "/admin/save-feedback", {
      token: tokenFor(admin),
      body: { userId: String(student._id), scheduleId, segment: "listening", feedback: "Synthetic result" },
    });
    assert.equal(feedback.status, 200);
    const reminder = await api("POST", "/send-reminder", { token: tokenFor(admin), body: {} });
    assert.notEqual(reminder.status, 423);
  });
  assert.equal((await bookings.findOne({ userId: String(student._id), scheduleId })).attendance, "absent");
});

test("F7-19..22,27: absent, 0, true, yes, and whitespace do not freeze; the flag is read dynamically", async () => {
  for (const value of [undefined, "0", "true", "yes", " 1"]) {
    await withFreeze(value, async () => {
      const result = await api("POST", "/user/book-slot");
      assert.notEqual(result.status, 423, `unexpected freeze for ${String(value)}`);
      assert.equal(result.status, 401);
    });
  }
  const student = await seedUser();
  const invalid = { userId: String(student._id), location: "Home" };
  await withFreeze("0", async () => {
    assert.equal((await api("POST", "/user/book-slot", { token: tokenFor(student), body: invalid })).status, 400);
  });
  await withFreeze("1", async () => {
    assert.equal((await api("POST", "/user/book-slot", { token: tokenFor(student), body: invalid })).status, 423);
  });
  await withFreeze(undefined, async () => {
    assert.equal((await api("POST", "/user/book-slot", { token: tokenFor(student), body: invalid })).status, 400);
  });
});

test("F7-23,28: freeze OFF preserves existing authentication on reads and writes", async () => {
  await withFreeze("0", async () => {
    assert.equal((await api("GET", "/user/bookings/not-an-id")).status, 401);
    const student = await seedUser();
    assert.equal((await api("DELETE", "/bookings/not-an-object-id", { token: tokenFor(student) })).status, 403);
  });
});

test("F7-24: a valid synthetic Home booking still succeeds while the flag is OFF", async () => {
  const course = { _id: new ObjectId(), name: "IELTS", homeBasedSystems: ["Computer-Based"] };
  await courses.insertOne(course);
  const student = await seedUser({
    mock: 1,
    totalMock: 1,
    mocks: [{
      mockType: "IELTS", testType: "Computer-Based", testSystem: "Academic", mock: 1,
      transactionId: `FIX07-${crypto.randomBytes(4).toString("hex")}`,
      mrValidation: "6 months", mrValidationExpiry: dhakaIsoIn(180),
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    }],
  });
  await withFreeze("0", async () => {
    const result = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: {
        userId: String(student._id), location: "Home", bookingDate: dhakaDateIn(7), testTime: "10:00",
        name: "IELTS", testType: "Computer-Based",
      },
    });
    assert.equal(result.status, 200);
  });
  assert.equal((await users.findOne({ _id: student._id })).mock, 0);
  assert.equal(await bookings.countDocuments({ userId: String(student._id), status: { $ne: "cancelled" } }), 1);
});

test("F7-25: a valid admin cancellation still succeeds while the flag is OFF", async () => {
  const admin = await adminUser();
  const student = await seedUser({ mock: 0, totalMock: 0 });
  const booking = { _id: new ObjectId(), userId: String(student._id), status: "pending", location: "Home" };
  await bookings.insertOne(booking);
  await withFreeze("0", async () => {
    const result = await api("DELETE", `/bookings/${booking._id}`, { token: tokenFor(admin) });
    assert.equal(result.status, 200);
  });
  assert.equal((await bookings.findOne({ _id: booking._id })).status, "cancelled");
  assert.equal((await users.findOne({ _id: student._id })).mock, 1);
});

test("F7-26: valid admin schedule creation still succeeds while the flag is OFF", async () => {
  const admin = await adminUser();
  const course = await seedUser();
  await withFreeze("0", async () => {
    const result = await api("POST", "/admin/create-schedule", {
      token: tokenFor(admin),
      body: [{
        courseId: String(course._id), startDate: "2031-03-10", endDate: "2031-03-10", testType: "Academic",
        timeSlots: [{ startTime: "09:00", endTime: "12:00", slot: 2, totalSlot: 2 }],
      }],
    });
    assert.equal(result.status, 201);
  });
  assert.equal(await schedules.countDocuments({ startDate: "2031-03-10" }), 1);
});

test("schedule deletion remains outside the three-route freeze scope", async () => {
  const admin = await adminUser();
  const schedule = { _id: new ObjectId(), courseId: "synthetic", startDate: "2031-03-11", endDate: "2031-03-11" };
  await schedules.insertOne(schedule);
  await withFreeze("1", async () => {
    const result = await api("DELETE", `/admin/delete-schedule/${schedule._id}`, { token: tokenFor(admin) });
    assert.notEqual(result.status, 423);
  });
});

test("D7-R01: frozen booking takes precedence over malformed raw JSON without side effects", async () => {
  const student = await seedUser({ mock: 2, totalMock: 2 });
  const beforeCount = await bookings.countDocuments({});
  const beforeLimiterCalls = instrumentedLimiterCalls;
  await withFreeze("1", async () => {
    const result = await apiRaw("POST", "/api/v1/user/book-slot", {
      headers: { "Content-Type": "application/json" },
      body: "{\"userId\":" ,
    });
    assert.equal(result.status, 423);
    assert.deepEqual(result.body, {
      message: "Booking has moved to the Luminedge portal",
      code: "BOOKING_FROZEN",
    });
  });
  assert.equal(instrumentedLimiterCalls, beforeLimiterCalls);
  assert.equal((await users.findOne({ _id: student._id })).mock, 2);
  assert.equal(await bookings.countDocuments({}), beforeCount);
});

test("D7-R01: the same malformed raw JSON reaches the existing parser while OFF", async () => {
  const beforeCount = await bookings.countDocuments({});
  await withFreeze("0", async () => {
    const result = await apiRaw("POST", "/api/v1/user/book-slot", {
      headers: { "Content-Type": "application/json" },
      body: "{\"userId\":" ,
    });
    assert.notEqual(result.status, 423);
    assert.equal(result.status, 500);
    assert.notEqual(result.body?.code, "BOOKING_FROZEN");
  });
  assert.equal(await bookings.countDocuments({}), beforeCount);
});

test("D7-R01: frozen writes bypass an exhausted limiter, while unrelated requests still reach it", async () => {
  const beforeProtected = instrumentedLimiterCalls;
  await withFreeze("1", async () => {
    const frozen = await api("POST", "/user/book-slot", {
      headers: { "X-Test-Force-Limit": "1" },
      body: { invalid: true },
    });
    assert.equal(frozen.status, 423);
    assert.equal(instrumentedLimiterCalls, beforeProtected);

    const unrelated = await api("POST", "/admin/save-feedback", {
      headers: { "X-Test-Force-Limit": "1" },
      body: {},
    });
    assert.equal(unrelated.status, 429);
    assert.equal(unrelated.body.code, "TEST_RATE_LIMITED");
    assert.equal(instrumentedLimiterCalls, beforeProtected + 1);
  });
});

test("D7-R01: all three paths honor case, trailing slash, query string, exact method and segment boundaries", async () => {
  await withFreeze("1", async () => {
    for (const [method, path] of [
      ["POST", "/API/V1/USER/BOOK-SLOT/?from=test"],
      ["DELETE", "/API/V1/BOOKINGS/not-an-id/?from=test"],
      ["POST", "/API/V1/ADMIN/CREATE-SCHEDULE/?from=test"],
    ]) {
      const result = await apiRaw(method, path, {
        headers: { "Content-Type": "application/json" }, body: "{broken",
      });
      assert.equal(result.status, 423, `${method} ${path}`);
      assert.equal(result.body.code, "BOOKING_FROZEN");
    }

    for (const [method, path] of [
      ["GET", "/user/book-slot"],
      ["POST", "/user/book-slot-extra"],
      ["DELETE", "/bookings/id/nested"],
      ["POST", "/admin/create-schedule/nested"],
    ]) {
      const result = await api(method, path);
      assert.notEqual(result.status, 423, `${method} ${path}`);
    }
  });
});

test("D7-R01: CORS and Helmet headers remain on frozen responses; disallowed origins retain CORS rejection", async () => {
  await withFreeze("1", async () => {
    const allowed = await apiRaw("POST", "/api/v1/user/book-slot", {
      headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
      body: "{bad",
    });
    assert.equal(allowed.status, 423);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");

    const disallowed = await apiRaw("POST", "/api/v1/user/book-slot", {
      headers: { Origin: "https://not-allowed.invalid", "Content-Type": "application/json" },
      body: "{bad",
    });
    assert.equal(disallowed.status, 403);
    assert.notEqual(disallowed.body?.code, "BOOKING_FROZEN");
    assert.equal(disallowed.headers.get("x-content-type-options"), "nosniff");
  });
});
