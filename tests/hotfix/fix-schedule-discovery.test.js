"use strict";

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
const TEST_DB_NAME = disposableDbName("schedulediscovery");

stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;

const createApp = require("../../app");
const JWT_SECRET = process.env.JWT_SECRET;

let client;
let db;
let usersCollection;
let schedulesCollection;
let coursesCollection;
let server;
let baseUrl;

const BASE_IELTS_ID = "67337c880794d577cd982b75";
const ALIAS_IELTS_ID = "6742b783d2f5950620f6df21";

const tokenFor = (user) =>
  jwt.sign(
    { userId: String(user._id), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

async function api(method, path, { token, body, headers = {} } = {}) {
  const reqHeaders = { "X-Forwarded-For": "127.0.0.1", ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) reqHeaders["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, body: json, rawText: text };
}

let studentUser;
let studentToken;

before(async () => {
  const conn = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME);
  client = conn.client;
  db = conn.db;

  usersCollection = db.collection("users");
  schedulesCollection = db.collection("schedules");
  coursesCollection = db.collection("courses");

  const app = createApp({
    usersCollection,
    schedulesCollection,
    coursesCollection,
    bookingMockCollection: db.collection("bookingMock"),
    reminderDeliveriesCollection: db.collection("reminderDeliveries"),
    client,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  studentUser = {
    _id: new ObjectId(),
    email: "student.k@synthetic.invalid",
    role: "user",
    status: "completed",
    mock: 5,
  };
  await usersCollection.insertOne(studentUser);
  studentToken = tokenFor(studentUser);

  await coursesCollection.insertMany([
    {
      _id: new ObjectId(BASE_IELTS_ID),
      name: "IELTS",
      courseName: "IELTS",
      testType: ["Computer-Based", "Paper-Based"],
    },
    {
      _id: new ObjectId(ALIAS_IELTS_ID),
      name: "IELTS Computer-Based",
      courseName: "IELTS Computer-Based",
      testType: ["Computer-Based"],
    },
  ]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) await client.close();
});

test("K06-T01: GET /schedule/:date/:courseId matches exact string date and string courseId", async () => {
  const scheduleId = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleId,
    courseId: BASE_IELTS_ID,
    name: "IELTS",
    testType: "Computer-Based",
    startDate: "2026-11-07",
    endDate: "2026-11-07",
    status: "Active",
    timeSlots: [
      { slotId: 1, time: "10:00 AM - 01:00 PM", totalSlot: 10, slot: 8 },
    ],
  });

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  assert.equal(res.body.schedules.length, 1);
  assert.equal(String(res.body.schedules[0]._id), String(scheduleId));

  await schedulesCollection.deleteOne({ _id: scheduleId });
});

test("K06-T02: GET /schedule/:date/:courseId matches ISO prefix date string", async () => {
  const scheduleId = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleId,
    courseId: BASE_IELTS_ID,
    name: "IELTS",
    testType: "Computer-Based",
    startDate: "2026-11-07T00:00:00.000Z",
    endDate: "2026-11-07T23:59:59.000Z",
    status: "Active",
    timeSlots: [
      { slotId: 1, time: "02:00 PM - 05:00 PM", totalSlot: 5, slot: 3 },
    ],
  });

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  assert.ok(res.body.schedules.some((s) => String(s._id) === String(scheduleId)));

  await schedulesCollection.deleteOne({ _id: scheduleId });
});

test("K06-T03: GET /schedule/:date/:courseId matches date ranges (startDate <= date <= endDate)", async () => {
  const scheduleId = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleId,
    courseId: BASE_IELTS_ID,
    name: "IELTS Multi-Day",
    testType: "Computer-Based",
    startDate: "2026-11-05",
    endDate: "2026-11-10",
    status: "Active",
    timeSlots: [
      { slotId: 1, time: "11:00 AM - 02:00 PM", totalSlot: 8, slot: 4 },
    ],
  });

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  assert.ok(res.body.schedules.some((s) => String(s._id) === String(scheduleId)));

  await schedulesCollection.deleteOne({ _id: scheduleId });
});

test("K06-T04: GET /schedule/:date/:courseId matches courseId stored as ObjectId", async () => {
  const scheduleId = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleId,
    courseId: new ObjectId(BASE_IELTS_ID),
    name: "IELTS",
    testType: "Computer-Based",
    startDate: "2026-11-07",
    endDate: "2026-11-07",
    status: "Active",
    timeSlots: [
      { slotId: 1, time: "10:00 AM - 01:00 PM", totalSlot: 10, slot: 6 },
    ],
  });

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  assert.ok(res.body.schedules.some((s) => String(s._id) === String(scheduleId)));

  await schedulesCollection.deleteOne({ _id: scheduleId });
});

test("K06-T05: GET /schedule/:date/:courseId resolves IELTS alias 6742b783d2f5950620f6df21 bi-directionally", async () => {
  const scheduleWithAlias = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleWithAlias,
    courseId: ALIAS_IELTS_ID,
    name: "IELTS Computer-Based",
    testType: "Computer-Based",
    startDate: "2026-11-07",
    endDate: "2026-11-07",
    status: "Active",
    timeSlots: [
      { slotId: 1, time: "09:00 AM - 12:00 PM", totalSlot: 12, slot: 10 },
    ],
  });

  // Querying using base course ID discovers schedule created under alias course ID
  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  assert.ok(res.body.schedules.some((s) => String(s._id) === String(scheduleWithAlias)));

  await schedulesCollection.deleteOne({ _id: scheduleWithAlias });
});

test("K06-T06: GET /schedule/:date/:courseId filters out cancelled schedules", async () => {
  const activeId = new ObjectId();
  const cancelledId = new ObjectId();
  await schedulesCollection.insertMany([
    {
      _id: activeId,
      courseId: BASE_IELTS_ID,
      name: "IELTS",
      testType: "Computer-Based",
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      status: "Active",
      timeSlots: [{ slotId: 1, time: "10:00 AM", totalSlot: 5, slot: 2 }],
    },
    {
      _id: cancelledId,
      courseId: BASE_IELTS_ID,
      name: "IELTS",
      testType: "Computer-Based",
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      status: "Cancelled",
      timeSlots: [{ slotId: 2, time: "02:00 PM", totalSlot: 5, slot: 0 }],
    },
  ]);

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));
  const ids = res.body.schedules.map((s) => String(s._id));
  assert.ok(ids.includes(String(activeId)));
  assert.ok(!ids.includes(String(cancelledId)));

  await schedulesCollection.deleteMany({ _id: { $in: [activeId, cancelledId] } });
});

test("K06-T07: Malformed slotId strings do not throw 500 in aggregation ($convert safety)", async () => {
  const scheduleId = new ObjectId();
  await schedulesCollection.insertOne({
    _id: scheduleId,
    courseId: BASE_IELTS_ID,
    name: "IELTS",
    testType: "Computer-Based",
    startDate: "2026-11-07",
    endDate: "2026-11-07",
    status: "Active",
    timeSlots: [
      { slotId: "not-a-number", time: "10:00 AM", totalSlot: 5, slot: 3 },
      { slotId: null, time: "02:00 PM", totalSlot: 5, slot: 2 },
    ],
  });

  const res = await api("GET", `/schedule/2026-11-07/${BASE_IELTS_ID}`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schedules));

  await schedulesCollection.deleteOne({ _id: scheduleId });
});

test("K06-T08: GET /schedule/course/:courseId returns unique schedules with available capacity", async () => {
  const s1 = new ObjectId();
  const s2 = new ObjectId();
  const s3Full = new ObjectId();
  const s4Cancelled = new ObjectId();

  await schedulesCollection.insertMany([
    {
      _id: s1,
      courseId: BASE_IELTS_ID,
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      status: "Active",
      timeSlots: [{ slotId: 1, totalSlot: 10, slot: 4 }],
    },
    {
      _id: s2,
      courseId: BASE_IELTS_ID,
      startDate: "2026-11-14",
      endDate: "2026-11-14",
      status: "Active",
      timeSlots: [{ slotId: 1, totalSlot: 10, slot: 2 }],
    },
    {
      _id: s3Full,
      courseId: BASE_IELTS_ID,
      startDate: "2026-11-21",
      endDate: "2026-11-21",
      status: "Active",
      timeSlots: [{ slotId: 1, totalSlot: 10, slot: 0 }],
    },
    {
      _id: s4Cancelled,
      courseId: BASE_IELTS_ID,
      startDate: "2026-11-28",
      endDate: "2026-11-28",
      status: "Cancelled",
      timeSlots: [{ slotId: 1, totalSlot: 10, slot: 5 }],
    },
  ]);

  const res = await api("GET", `/schedule/course/${BASE_IELTS_ID}?month=2026-11`, {
    token: studentToken,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  const dates = res.body.schedules.map((s) => s.startDate);
  assert.ok(dates.includes("2026-11-07"), "Must include 2026-11-07");
  assert.ok(dates.includes("2026-11-14"), "Must include 2026-11-14");
  assert.ok(!dates.includes("2026-11-28"), "Must exclude cancelled date 2026-11-28");

  await schedulesCollection.deleteMany({ _id: { $in: [s1, s2, s3Full, s4Cancelled] } });
});

test("K06-T09: GET /schedule/course/:courseId requires authentication", async () => {
  const res = await api("GET", `/schedule/course/${BASE_IELTS_ID}`);
  assert.equal(res.status, 401);
});
