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
const TEST_DB_NAME = disposableDbName("fixreschedule");

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
let bookingMockCollection;
let coursesCollection;
let reminderDeliveriesCollection;
let server;
let baseUrl;

let bookableCourse;

const tokenFor = (user, overrides = {}) =>
  jwt.sign(
    { userId: String(user._id), role: user.role, email: user.email, ...overrides },
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

const dhakaDateIn = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000 + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

const dhakaIsoIn = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

async function seedUser(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "Synthetic Student",
    email: `student.${crypto.randomBytes(6).toString("hex")}@synthetic.invalid`,
    role: "user",
    status: "completed",
    isDeleted: false,
    mock: 5,
    totalMock: 5,
    mockType: "IELTS",
    testType: "Computer-Based",
    mocks: [
      {
        mockType: "IELTS",
        testType: "Computer-Based",
        mock: 5,
        transactionId: `MR-${crypto.randomBytes(6).toString("hex")}`,
        mrValidation: "6 months",
        mrValidationExpiry: dhakaIsoIn(180),
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    ],
    ...overrides,
  };
  await usersCollection.insertOne(doc);
  return doc;
}

async function seedCourse(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "IELTS",
    homeBasedSystems: ["Computer-Based"],
    ...overrides,
  };
  await coursesCollection.insertOne(doc);
  return doc;
}

async function newSchedule(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    courseId: String(bookableCourse._id),
    name: "IELTS",
    testType: "Computer-Based",
    startDate: dhakaDateIn(5),
    endDate: dhakaDateIn(5),
    status: "Scheduled",
    venue: "Main Campus",
    timeSlots: [
      { slotId: "slot-1", startTime: "10:00:00", endTime: "13:00:00", slot: 5, totalSlot: 5 },
      { slotId: "slot-2", startTime: "14:00:00", endTime: "17:00:00", slot: 3, totalSlot: 3 },
    ],
    ...overrides,
  };
  await schedulesCollection.insertOne(doc);
  return doc;
}

async function seedBooking(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    status: "pending",
    name: "IELTS",
    testType: "Computer-Based",
    testSystem: "Computer-Based",
    location: "Home",
    bookingDate: dhakaDateIn(4),
    testTime: "10:00",
    ...overrides,
  };
  assert.ok(doc.userId, "seedBooking requires an explicit userId");
  await bookingMockCollection.insertOne(doc);
  return doc;
}

async function seedCenterBooking({ student, schedule, slotId = "slot-1", ...overrides }) {
  const slot = (schedule.timeSlots || []).find((s) => s.slotId === slotId);
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Test Center",
    scheduleId: String(schedule._id),
    slotId,
    bookingDate: schedule.startDate,
    startTime: slot ? slot.startTime : "10:00:00",
    endTime: slot ? slot.endTime : "13:00:00",
    ...overrides,
  });

  // Consume seat as normal booking does
  await schedulesCollection.updateOne(
    { _id: schedule._id, timeSlots: { $elemMatch: { slotId, slot: { $gt: 0 } } } },
    { $inc: { "timeSlots.$.slot": -1 } }
  );

  return booking;
}

before(async () => {
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));
  usersCollection = db.collection("users");
  schedulesCollection = db.collection("schedules");
  bookingMockCollection = db.collection("bookingMock");
  coursesCollection = db.collection("courses");
  reminderDeliveriesCollection = db.collection("reminderDeliveries");

  bookableCourse = await seedCourse();

  const app = createApp({
    usersCollection,
    schedulesCollection,
    bookingMockCollection,
    coursesCollection,
    reminderDeliveriesCollection,
    client,
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) await client.close();
});

// ---------------------------------------------------------------------------
// TEST SUITE: STUDENT SELF-RESCHEDULING (R02)
// ---------------------------------------------------------------------------

test("T01: Successful Test Center rescheduling with >= 24h notice updates slots and booking atomically", async () => {
  const student = await seedUser({ mock: 3 });
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const schedABefore = await schedulesCollection.findOne({ _id: scheduleA._id });
  const schedBBefore = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedABefore.timeSlots[0].slot, 4);
  assert.equal(schedBBefore.timeSlots[1].slot, 3);

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-2",
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);

  // Seat accounting: old slot restored (+1), new slot claimed (-1)
  const schedAAfter = await schedulesCollection.findOne({ _id: scheduleA._id });
  const schedBAfter = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedAAfter.timeSlots[0].slot, 5, "Old slot must be restored to 5");
  assert.equal(schedBAfter.timeSlots[1].slot, 2, "New slot must be decremented to 2");

  // Mock credit invariant: strictly untouched
  const studentAfter = await usersCollection.findOne({ _id: student._id });
  assert.equal(studentAfter.mock, 3, "Student mock credit balance must remain untouched");

  // Booking document updated
  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(updatedBooking.scheduleId, String(scheduleB._id));
  assert.equal(updatedBooking.slotId, "slot-2");
  assert.equal(updatedBooking.bookingDate, scheduleB.startDate);
  assert.equal(updatedBooking.startTime, "14:00:00");
  assert.equal(updatedBooking.rescheduleCount, 1);
  assert.equal(updatedBooking.rescheduleHistory.length, 1);
  assert.equal(updatedBooking.rescheduleHistory[0].previousScheduleId, String(scheduleA._id));
});

test("T02: Successful Home rescheduling with >= 24h notice updates date/time without altering slots or credits", async () => {
  const student = await seedUser({ mock: 2 });
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dhakaDateIn(3),
    testTime: "10:00",
  });

  const targetDate = dhakaDateIn(5);
  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newBookingDate: targetDate,
      newTestTime: "15:00",
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);

  const studentAfter = await usersCollection.findOne({ _id: student._id });
  assert.equal(studentAfter.mock, 2, "Mock balance must not change");

  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(updatedBooking.bookingDate, targetDate);
  assert.equal(updatedBooking.testTime, "15:00");
  assert.equal(updatedBooking.rescheduleCount, 1);
});

test("T03: Same-day Home rescheduling allows different time and is not blocked by duplicate check", async () => {
  const student = await seedUser({ mock: 1 });
  const sameDate = dhakaDateIn(4);
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: sameDate,
    testTime: "10:00",
  });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newBookingDate: sameDate,
      newTestTime: "14:00",
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(updatedBooking.bookingDate, sameDate);
  assert.equal(updatedBooking.testTime, "14:00");
});

test("T04: Duplicate active booking on target date/slot is rejected with 400", async () => {
  const student = await seedUser({ mock: 4 });
  const schedule = await newSchedule({ startDate: dhakaDateIn(5) });

  const booking1 = await seedCenterBooking({ student, schedule, slotId: "slot-1" });
  const booking2 = await seedCenterBooking({ student, schedule, slotId: "slot-2" });

  const res = await api("PATCH", `/user/bookings/${booking1._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(schedule._id),
      newSlotId: "slot-2",
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /already have an active booking/i);
});

test("T05: MR entitlement transfer allows student with 1 MR to reschedule their single active booking", async () => {
  const student = await seedUser({
    mock: 0,
    mocks: [
      {
        mockType: "IELTS",
        testType: "Computer-Based",
        mock: 1,
        transactionId: `MR-${crypto.randomBytes(6).toString("hex")}`,
        mrValidation: "6 months",
        mrValidationExpiry: dhakaIsoIn(90),
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    ],
  });

  const scheduleA = await newSchedule({ startDate: dhakaDateIn(3) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(7) });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
});

test("T06: Rescheduling to a date past MR expiry is rejected with 400", async () => {
  const student = await seedUser({
    mocks: [
      {
        mockType: "IELTS",
        testType: "Computer-Based",
        mock: 1,
        transactionId: `MR-${crypto.randomBytes(6).toString("hex")}`,
        mrValidation: "6 months",
        mrValidationExpiry: dhakaIsoIn(10),
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    ],
  });

  const scheduleA = await newSchedule({ startDate: dhakaDateIn(3) });
  const scheduleFar = await newSchedule({ startDate: dhakaDateIn(15) });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleFar._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /mock entitlement does not cover/i);
});

test("T07: Reschedule request at under 24 hours notice on current booking is rejected with 400", async () => {
  const student = await seedUser();
  const soonDate = new Date(Date.now() + 12 * 3600 * 1000 + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
  const soonTime = new Date(Date.now() + 12 * 3600 * 1000 + DHAKA_OFFSET_MS).toISOString().slice(11, 16);

  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: soonDate,
    testTime: soonTime,
  });

  const targetDate = dhakaDateIn(5);
  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newBookingDate: targetDate,
      newTestTime: "10:00",
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /at least 24 hours before/i);
});

test("T08: Legacy booking without rescheduleCount field reschedules successfully and initializes counter", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });
  await bookingMockCollection.updateOne({ _id: booking._id }, { $unset: { rescheduleCount: "", rescheduleHistory: "" } });

  const rawBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(rawBooking.rescheduleCount, undefined);

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(updatedBooking.rescheduleCount, 1);
  assert.equal(updatedBooking.rescheduleHistory.length, 1);
});

test("T09: Preserves legacy slotId types (numeric and string)", async () => {
  const student = await seedUser();
  const legacySchedule = await newSchedule({
    startDate: dhakaDateIn(4),
    timeSlots: [
      { slotId: 101, startTime: "09:00:00", endTime: "12:00:00", slot: 4, totalSlot: 5 },
      { slotId: 102, startTime: "13:00:00", endTime: "16:00:00", slot: 3, totalSlot: 3 },
    ],
  });

  const booking = await seedCenterBooking({ student, schedule: legacySchedule, slotId: 101 });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(legacySchedule._id),
      newSlotId: 102,
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const schedAfter = await schedulesCollection.findOne({ _id: legacySchedule._id });
  assert.equal(schedAfter.timeSlots[0].slot, 4, "Old slot 101 incremented");
  assert.equal(schedAfter.timeSlots[1].slot, 2, "New slot 102 decremented");
});

test("T10: Destination slot full (slot: 0) is rejected with 409 and original booking remains safe", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleFull = await newSchedule({
    startDate: dhakaDateIn(6),
    timeSlots: [
      { slotId: "full-slot", startTime: "10:00:00", endTime: "13:00:00", slot: 0, totalSlot: 5 },
    ],
  });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleFull._id),
      newSlotId: "full-slot",
    },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /fully booked/i);

  const schedA = await schedulesCollection.findOne({ _id: scheduleA._id });
  assert.equal(schedA.timeSlots[0].slot, 4, "Old seat must not be released if new seat claim fails");
  const origBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(origBooking.scheduleId, String(scheduleA._id));
});

test("T11: Corrupted old-seat counters (available >= capacity) aborts transfer with 409", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({
    startDate: dhakaDateIn(4),
    timeSlots: [
      { slotId: "slot-1", startTime: "10:00:00", endTime: "13:00:00", slot: 5, totalSlot: 5 },
    ],
  });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });

  const booking = await seedBooking({
    userId: String(student._id),
    location: "Test Center",
    scheduleId: String(scheduleA._id),
    slotId: "slot-1",
    bookingDate: scheduleA.startDate,
    startTime: "10:00:00",
    endTime: "13:00:00",
  });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 409);

  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 5);
});

test("T12: Same-slot reschedule attempt is rejected with 400", async () => {
  const student = await seedUser();
  const schedule = await newSchedule({ startDate: dhakaDateIn(4) });
  const booking = await seedCenterBooking({ student, schedule, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(schedule._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /identical to your current booking/i);
});

test("T13: Idempotent repeated request with same Idempotency-Key returns 200 without duplicate transfer", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const idempotencyKey = `req-${crypto.randomBytes(8).toString("hex")}`;

  const res1 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(res1.status, 200);

  const res2 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.idempotent, true);

  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 4, "Slot must be decremented only once (5 -> 4)");

  const afterSecond = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(afterSecond.rescheduleCount, 1, "Reschedule count must not increment twice");
  assert.equal(afterSecond.rescheduleHistory.length, 1, "History must have exactly 1 entry");
});

test("T14: Rescheduling another student's booking is rejected with 403", async () => {
  const studentA = await seedUser();
  const studentB = await seedUser();
  const schedule = await newSchedule({ startDate: dhakaDateIn(4) });
  const bookingA = await seedCenterBooking({ student: studentA, schedule, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${bookingA._id}/reschedule`, {
    token: tokenFor(studentB),
    body: {
      newScheduleId: String(schedule._id),
      newSlotId: "slot-2",
    },
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /not authorized/i);
});

test("T15: Rescheduling a cancelled or attended booking is rejected with 409", async () => {
  const student = await seedUser();
  const schedule = await newSchedule({ startDate: dhakaDateIn(4) });

  const cancelledBooking = await seedBooking({
    userId: String(student._id),
    status: "cancelled",
    bookingDate: dhakaDateIn(4),
  });

  const res1 = await api("PATCH", `/user/bookings/${cancelledBooking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(schedule._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(res1.status, 404);

  const attendedBooking = await seedBooking({
    userId: String(student._id),
    status: "Present",
    attendance: "Present",
    bookingDate: dhakaDateIn(4),
  });

  const res2 = await api("PATCH", `/user/bookings/${attendedBooking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(schedule._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(res2.status, 409);
  assert.match(res2.body.message, /recorded attendance/i);
});

test("T16: BOOKING_FROZEN=1 blocks rescheduling with 423 at early interceptor and route levels", async () => {
  const student = await seedUser();
  const schedule = await newSchedule({ startDate: dhakaDateIn(4) });
  const booking = await seedCenterBooking({ student, schedule, slotId: "slot-1" });

  process.env.BOOKING_FROZEN = "1";
  try {
    const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: {
        newScheduleId: String(schedule._id),
        newSlotId: "slot-2",
      },
    });

    assert.equal(res.status, 423);
    assert.equal(res.body.code, "BOOKING_FROZEN");
  } finally {
    delete process.env.BOOKING_FROZEN;
  }
});

// ---------------------------------------------------------------------------
// NEW HARDENING TESTS: FIX A THROUGH FIX F
// ---------------------------------------------------------------------------

test("T17 (FIX A): Ownership verified before idempotency: Student B cannot inspect Student A's booking with matching key", async () => {
  const studentA = await seedUser();
  const studentB = await seedUser();
  const schedule = await newSchedule({ startDate: dhakaDateIn(4) });
  const bookingA = await seedCenterBooking({ student: studentA, schedule, slotId: "slot-1" });

  const sharedKey = `idemp-${crypto.randomBytes(8).toString("hex")}`;

  // Student A sets up the key with a successful reschedule
  const targetSchedule = await newSchedule({ startDate: dhakaDateIn(6) });
  const resA = await api("PATCH", `/user/bookings/${bookingA._id}/reschedule`, {
    token: tokenFor(studentA),
    headers: { "Idempotency-Key": sharedKey },
    body: {
      newScheduleId: String(targetSchedule._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(resA.status, 200);

  // Student B attempts to query Student A's booking using the same key
  const resB = await api("PATCH", `/user/bookings/${bookingA._id}/reschedule`, {
    token: tokenFor(studentB),
    headers: { "Idempotency-Key": sharedKey },
    body: {
      newScheduleId: String(targetSchedule._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(resB.status, 403, "Student B must be rejected 403 Forbidden");
  assert.equal(resB.body.bookingRecord, undefined, "No booking record may be leaked to Student B");
  assert.match(resB.body.message, /not authorized/i);
});

test("T18 (FIX B): Home duplicate rule rejects rescheduling to date with another active Home booking regardless of time", async () => {
  const student = await seedUser({ mock: 4 });
  const dateX = dhakaDateIn(4);
  const dateY = dhakaDateIn(6);

  // Student has two active Home bookings: Booking 1 on dateX (10:00), Booking 2 on dateY (15:00)
  const booking1 = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dateX,
    testTime: "10:00",
  });
  const booking2 = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dateY,
    testTime: "15:00",
  });

  // Student tries to reschedule Booking 2 to dateX at a DIFFERENT time (18:00)
  // Should be REJECTED because dateX already has active Booking 1!
  const res = await api("PATCH", `/user/bookings/${booking2._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newBookingDate: dateX,
      newTestTime: "18:00",
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /already have an active Home mock test booked for this date/i);
});

test("T19 (FIX D): Durable idempotency rejects reused key when request parameters differ", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const idempotencyKey = `durable-key-${crypto.randomBytes(8).toString("hex")}`;

  // First call targeting slot-1
  const res1 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });
  assert.equal(res1.status, 200);

  // Second call using SAME key but DIFFERENT payload (targeting slot-2)
  const res2 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-2",
    },
  });

  assert.equal(res2.status, 409);
  assert.match(res2.body.message, /different request parameters/i);
});

test("T20 (FIX D): Replaying historical idempotency key from earlier reschedule is rejected with 409", async () => {
  const student = await seedUser();
  const sched1 = await newSchedule({ startDate: dhakaDateIn(3) });
  const sched2 = await newSchedule({ startDate: dhakaDateIn(5) });
  const sched3 = await newSchedule({ startDate: dhakaDateIn(7) });

  const booking = await seedCenterBooking({ student, schedule: sched1, slotId: "slot-1" });

  const key1 = `hist-key-1-${crypto.randomBytes(6).toString("hex")}`;
  const key2 = `hist-key-2-${crypto.randomBytes(6).toString("hex")}`;

  // Reschedule 1 using key1
  const res1 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": key1 },
    body: { newScheduleId: String(sched2._id), newSlotId: "slot-1" },
  });
  assert.equal(res1.status, 200);

  // Reschedule 2 using key2
  const res2 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": key2 },
    body: { newScheduleId: String(sched3._id), newSlotId: "slot-1" },
  });
  assert.equal(res2.status, 200);

  // Replay older key1: should be rejected as used for previous reschedule
  const resReplay = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": key1 },
    body: { newScheduleId: String(sched2._id), newSlotId: "slot-1" },
  });

  assert.equal(resReplay.status, 409);
  assert.match(resReplay.body.message, /used for a previous reschedule/i);
});

test("T21 (FIX E): Durable lastRescheduleOpId is recorded on successful reschedule", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 200);
  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.ok(updatedBooking.lastRescheduleOpId, "lastRescheduleOpId must be set on booking");
  assert.equal(typeof updatedBooking.lastRescheduleOpId, "string");
  assert.equal(updatedBooking.rescheduleHistory[0].rescheduleOpId, updatedBooking.lastRescheduleOpId);
});

test("T22 (FIX F1): Concurrency — Two students competing for the last available seat in a slot", async () => {
  const studentA = await seedUser();
  const studentB = await seedUser();

  const schedA = await newSchedule({ startDate: dhakaDateIn(3) });
  const schedB = await newSchedule({ startDate: dhakaDateIn(3) });

  // Schedule Target has exactly 1 available seat in slot-1
  const schedTarget = await newSchedule({
    startDate: dhakaDateIn(6),
    timeSlots: [
      { slotId: "last-seat", startTime: "10:00:00", endTime: "13:00:00", slot: 1, totalSlot: 5 },
    ],
  });

  const bookingA = await seedCenterBooking({ student: studentA, schedule: schedA, slotId: "slot-1" });
  const bookingB = await seedCenterBooking({ student: studentB, schedule: schedB, slotId: "slot-1" });

  // Both students attempt to reschedule to the same single remaining seat concurrently
  const [resA, resB] = await Promise.all([
    api("PATCH", `/user/bookings/${bookingA._id}/reschedule`, {
      token: tokenFor(studentA),
      body: { newScheduleId: String(schedTarget._id), newSlotId: "last-seat" },
    }),
    api("PATCH", `/user/bookings/${bookingB._id}/reschedule`, {
      token: tokenFor(studentB),
      body: { newScheduleId: String(schedTarget._id), newSlotId: "last-seat" },
    }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], "Exactly one student succeeds (200) and one receives conflict (409)");

  // Inspect database state directly:
  const targetSchedAfter = await schedulesCollection.findOne({ _id: schedTarget._id });
  assert.equal(targetSchedAfter.timeSlots[0].slot, 0, "Slot capacity must end at exactly 0 (never negative)");

  // Winner's booking updated, loser's booking preserved
  const [winnerBooking, loserBooking] = resA.status === 200 ? [bookingA, bookingB] : [bookingB, bookingA];
  const winnerDoc = await bookingMockCollection.findOne({ _id: winnerBooking._id });
  const loserDoc = await bookingMockCollection.findOne({ _id: loserBooking._id });

  assert.equal(winnerDoc.scheduleId, String(schedTarget._id));
  assert.equal(winnerDoc.slotId, "last-seat");
  assert.notEqual(loserDoc.scheduleId, String(schedTarget._id), "Loser must retain original schedule");
});

test("T23 (FIX F2): Concurrency — Simultaneous reschedule requests for the same booking", async () => {
  const student = await seedUser();
  const schedOrigin = await newSchedule({ startDate: dhakaDateIn(3) });
  const schedTarget1 = await newSchedule({ startDate: dhakaDateIn(5) });
  const schedTarget2 = await newSchedule({ startDate: dhakaDateIn(7) });

  const booking = await seedCenterBooking({ student, schedule: schedOrigin, slotId: "slot-1" });

  // Student fires two simultaneous requests for the same booking to different schedules
  const [res1, res2] = await Promise.all([
    api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(schedTarget1._id), newSlotId: "slot-1" },
    }),
    api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(schedTarget2._id), newSlotId: "slot-1" },
    }),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409], "Exactly one concurrent reschedule succeeds and one fails");

  const finalBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(finalBooking.rescheduleCount, 1, "Must only increment rescheduleCount once");
});

test("T24 (FIX F3): Concurrency / Transaction-Consistency — Original booking modified concurrently aborts transfer", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  // Concurrently change booking status to 'cancelled' right before updateOne executes
  await bookingMockCollection.updateOne({ _id: booking._id }, { $set: { status: "cancelled" } });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 404, "Must detect that booking is no longer active");

  // Verify Schedule B seat was NOT decremented
  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 5, "Target slot must remain 5");
});

test("T25 (FIX F4): Concurrency — Schedule cancelled during rescheduling aborts transaction with 404", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6), status: "cancelled" });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleB._id),
      newSlotId: "slot-1",
    },
  });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /schedule is no longer available/i);
});

test("T26 (FIX F5): Full transaction rollback leaves database state completely untouched on seat conflict", async () => {
  const student = await seedUser({ mock: 7 });
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleFull = await newSchedule({
    startDate: dhakaDateIn(6),
    timeSlots: [
      { slotId: "empty-slot", startTime: "10:00:00", endTime: "13:00:00", slot: 0, totalSlot: 5 },
    ],
  });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: {
      newScheduleId: String(scheduleFull._id),
      newSlotId: "empty-slot",
    },
  });

  assert.equal(res.status, 409);

  // Database verification:
  const studentDoc = await usersCollection.findOne({ _id: student._id });
  assert.equal(studentDoc.mock, 7, "Student credits untouched");

  const schedADoc = await schedulesCollection.findOne({ _id: scheduleA._id });
  assert.equal(schedADoc.timeSlots[0].slot, 4, "Old slot counter untouched (4/5)");

  const schedFullDoc = await schedulesCollection.findOne({ _id: scheduleFull._id });
  assert.equal(schedFullDoc.timeSlots[0].slot, 0, "Target slot untouched (0/5)");

  const bookingDoc = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(bookingDoc.scheduleId, String(scheduleA._id));
  assert.equal(bookingDoc.rescheduleCount, undefined);
  assert.equal(bookingDoc.rescheduleHistory, undefined);
});

// ---------------------------------------------------------------------------
// R02 FINAL INTEGRITY GATE TESTS (T27 - T35)
// ---------------------------------------------------------------------------

test("T27 (FIX 1): Key A success -> subsequent reschedule -> replay Key A rejected with 409", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const scheduleC = await newSchedule({ startDate: dhakaDateIn(8) });

  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const keyA = "idemp-key-A";
  // Step 1: Reschedule from Schedule A to Schedule B using Key A
  const resA = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": keyA },
    body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
  });
  assert.equal(resA.status, 200, "Initial reschedule with Key A succeeds");
  assert.equal(resA.body.bookingRecord.scheduleId, String(scheduleB._id));

  // Step 2: Reschedule from Schedule B to Schedule C WITHOUT key (unkeyed subsequent reschedule)
  const resB = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    body: { newScheduleId: String(scheduleC._id), newSlotId: "slot-1" },
  });
  assert.equal(resB.status, 200, "Subsequent unkeyed reschedule succeeds");
  assert.equal(resB.body.bookingRecord.scheduleId, String(scheduleC._id));

  // Step 3: Replay Key A (requesting Schedule B again)
  const resReplay = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": keyA },
    body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
  });

  // MUST NOT return 200 or claim success for Schedule B!
  assert.equal(resReplay.status, 409, "Replaying historical key after subsequent reschedule must be rejected with 409");
  assert.match(resReplay.body.message, /previous reschedule operation/i);

  // Booking in database remains on Schedule C
  const bookingDoc = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(bookingDoc.scheduleId, String(scheduleC._id), "Booking must remain on Schedule C");
});

test("T28 (FIX 2A): Concurrency — Two different Home bookings from same student reschedule to same destination date", async () => {
  const student = await seedUser({ mock: 4 });
  const destDate = dhakaDateIn(6);

  // Two distinct existing Home bookings on different dates
  const booking1 = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dhakaDateIn(3),
    testTime: "10:00",
  });
  const booking2 = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dhakaDateIn(4),
    testTime: "14:00",
  });

  // Fire concurrent reschedule requests targeting the SAME destination date
  const [res1, res2] = await Promise.all([
    api("PATCH", `/user/bookings/${booking1._id}/reschedule`, {
      token: tokenFor(student),
      body: { newBookingDate: destDate, newTestTime: "10:00" },
    }),
    api("PATCH", `/user/bookings/${booking2._id}/reschedule`, {
      token: tokenFor(student),
      body: { newBookingDate: destDate, newTestTime: "14:00" },
    }),
  ]);

  const statuses = [res1.status, res2.status].sort();
  // Exactly one succeeds (200), one is rejected (400 duplicate or 409 conflict)
  assert.equal(statuses[0], 200, "Winner must succeed with 200");
  assert.ok(statuses[1] === 400 || statuses[1] === 409, `Loser must be rejected, got ${statuses[1]}`);

  // CRITICAL ASSERTION: At most ONE active Home booking exists on destDate in database!
  const destBookings = await bookingMockCollection.find({
    userId: String(student._id),
    bookingDate: destDate,
    location: "Home",
    status: { $nin: ["cancelled", "refunded"] },
  }).toArray();

  assert.equal(destBookings.length, 1, "Exactly one active Home booking must occupy destDate");

  // Student mock credits strictly untouched
  const studentDoc = await usersCollection.findOne({ _id: student._id });
  assert.equal(studentDoc.mock, 4, "Student mock credits must not change");
});

test("T29 (FIX 2B): Concurrency — New Home booking races against Home reschedule for same student on same destination date", async () => {
  const student = await seedUser({ mock: 3 });
  const destDate = dhakaDateIn(5);

  const existingBooking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: dhakaDateIn(3),
    testTime: "10:00",
  });

  // Race: POST /user/book-slot (new Home booking) vs PATCH /user/bookings/:id/reschedule (rescheduling existing Home booking)
  const [resNew, resResched] = await Promise.all([
    api("POST", `/user/book-slot`, {
      token: tokenFor(student),
      body: {
        userId: String(student._id),
        location: "Home",
        name: bookableCourse.name,
        testType: "Computer-Based",
        testSystem: "Mac",
        bookingDate: destDate,
        testTime: "14:00",
      },
    }),
    api("PATCH", `/user/bookings/${existingBooking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newBookingDate: destDate, newTestTime: "10:00" },
    }),
  ]);

  // CRITICAL ASSERTION: At most ONE active Home booking exists on destDate in database!
  const destBookings = await bookingMockCollection.find({
    userId: String(student._id),
    bookingDate: destDate,
    location: "Home",
    status: { $nin: ["cancelled", "refunded"] },
  }).toArray();

  assert.equal(destBookings.length, 1, "At most one active Home booking can occupy the contested date");
});

test("T30 (FIX 3.1): Fault Injection — Original booking modified concurrently mid-transaction aborts transfer and rolls back", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const origUpdateOne = schedulesCollection.updateOne.bind(schedulesCollection);
  let hooked = false;
  schedulesCollection.updateOne = async function (filter, update, options) {
    const res = await origUpdateOne(filter, update, options);
    if (!hooked && options && options.session) {
      hooked = true;
      // Mutate original booking outside the transaction session
      await bookingMockCollection.updateOne(
        { _id: booking._id },
        { $set: { bookingDate: "2099-12-31" } }
      );
    }
    return res;
  };

  try {
    const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
    assert.equal(res.status, 409, "Must return 409 conflict when booking is concurrently modified mid-transaction");
  } finally {
    schedulesCollection.updateOne = origUpdateOne;
  }

  // Verify rollback: Schedule B seat was NOT decremented
  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 5, "Schedule B slot must remain 5 (rolled back)");
  const schedA = await schedulesCollection.findOne({ _id: scheduleA._id });
  assert.equal(schedA.timeSlots[0].slot, 4, "Schedule A slot must remain 4 (rolled back)");
});

test("T31 (FIX 3.2): Fault Injection — Destination schedule cancelled mid-transaction aborts and rolls back", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const origFindOne = schedulesCollection.findOne.bind(schedulesCollection);
  let hooked = false;
  schedulesCollection.findOne = async function (filter, options) {
    if (!hooked && options && options.session && filter && String(filter._id) === String(scheduleB._id)) {
      hooked = true;
      // Mark destination schedule as cancelled in the database right as it is being evaluated
      await schedulesCollection.updateOne({ _id: scheduleB._id }, { $set: { status: "cancelled" } });
    }
    return origFindOne(filter, options);
  };

  try {
    const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
    assert.equal(res.status, 404, "Must abort with 404 when schedule is cancelled in flight");
  } finally {
    schedulesCollection.findOne = origFindOne;
  }

  // Database assertions: booking untouched, credits untouched
  const bDoc = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(bDoc.scheduleId, String(scheduleA._id));
  const uDoc = await usersCollection.findOne({ _id: student._id });
  assert.equal(uDoc.mock, student.mock);
});

test("T32 (FIX 3.3): Fault Injection — Destination seat claimed, followed by failure of old-seat restoration", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const origUpdateOne = schedulesCollection.updateOne.bind(schedulesCollection);
  let updateCount = 0;
  schedulesCollection.updateOne = async function (filter, update, options) {
    if (options && options.session) {
      updateCount++;
      if (updateCount === 1) {
        // Step 1: Claim new seat on scheduleB -> execute normally
        const r1 = await origUpdateOne(filter, update, options);
        // Now corrupt old seat on scheduleA outside the session so the restoration compare-and-set will fail
        await schedulesCollection.updateOne(
          { _id: scheduleA._id, "timeSlots.slotId": "slot-1" },
          { $set: { "timeSlots.$.slot": 99 } }
        );
        return r1;
      }
    }
    return origUpdateOne(filter, update, options);
  };

  try {
    const res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
    assert.equal(res.status, 409, "Must abort with 409 when old seat restoration fails");
    assert.match(res.body.message, /(restore previous seat counter|configured capacity)/i);
  } finally {
    schedulesCollection.updateOne = origUpdateOne;
  }

  // PROVE ROLLBACK: Even though Schedule B had its seat decremented in Step 1,
  // the transaction abort completely rolled it back!
  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 5, "Schedule B slot must be rolled back to 5 (not decremented to 4)");
  const bookingDoc = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(bookingDoc.scheduleId, String(scheduleA._id), "Booking must remain on Schedule A");
});

test("T33 (FIX 3.4): Fault Injection — UnknownTransactionCommitResult followed by successful commit reconciliation", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const origStartSession = client.startSession.bind(client);
  client.startSession = function () {
    const session = origStartSession();
    const origCommit = session.commitTransaction.bind(session);
    session.commitTransaction = async function () {
      // Actually commit to database so durable changes are written
      await origCommit();
      // Throw simulated UnknownTransactionCommitResult
      const err = new Error("Connection reset by peer during commit");
      err.errorLabels = ["UnknownTransactionCommitResult"];
      err.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult";
      throw err;
    };
    return session;
  };

  let res;
  try {
    res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
  } finally {
    client.startSession = origStartSession;
  }

  // Reconciliation detects lastRescheduleOpId in database and recovers with 200
  assert.equal(res.status, 200, "Reconciliation must recover to 200 OK");
  assert.equal(res.body.success, true);

  const updatedBooking = await bookingMockCollection.findOne({ _id: booking._id });
  assert.equal(updatedBooking.scheduleId, String(scheduleB._id));
  assert.ok(updatedBooking.lastRescheduleOpId, "Durable operation ID must be present");
});

test("T34 (FIX 3.5): Fault Injection — Repeated UnknownTransactionCommitResult with indeterminate final state returns 503 COMMITTED_OR_UNCERTAIN", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const origStartSession = client.startSession.bind(client);
  client.startSession = function () {
    const session = origStartSession();
    session.commitTransaction = async function () {
      // Throw without actually committing
      const err = new Error("Cluster failover in progress");
      err.errorLabels = ["UnknownTransactionCommitResult"];
      err.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult";
      throw err;
    };
    return session;
  };

  let res;
  try {
    res = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
  } finally {
    client.startSession = origStartSession;
  }

  assert.equal(res.status, 503, "Must return 503 when commit outcome is uncertain");
  assert.equal(res.body.code, "COMMITTED_OR_UNCERTAIN");

  // Booking in database does NOT have the attempted schedule committed
  const bookingAfter = await bookingMockCollection.findOne({ _id: booking._id });
  assert.notEqual(bookingAfter.scheduleId, String(scheduleB._id));
});

test("T35 (FIX 3.6): Fault Injection — Same request retried after an uncertain outcome", async () => {
  const student = await seedUser();
  const scheduleA = await newSchedule({ startDate: dhakaDateIn(4) });
  const scheduleB = await newSchedule({ startDate: dhakaDateIn(6) });
  const booking = await seedCenterBooking({ student, schedule: scheduleA, slotId: "slot-1" });

  const idempotencyKey = `retry-key-${Date.now()}`;
  const origStartSession = client.startSession.bind(client);

  // Attempt 1: Simulates commit throwing UnknownTransactionCommitResult after commit succeeds
  client.startSession = function () {
    const session = origStartSession();
    const origCommit = session.commitTransaction.bind(session);
    session.commitTransaction = async function () {
      await origCommit();
      const err = new Error("Transient network drop during commit ack");
      err.errorLabels = ["UnknownTransactionCommitResult"];
      err.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult";
      throw err;
    };
    return session;
  };

  let res1;
  try {
    res1 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
      token: tokenFor(student),
      headers: { "Idempotency-Key": idempotencyKey },
      body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
    });
  } finally {
    client.startSession = origStartSession;
  }
  assert.equal(res1.status, 200, "Attempt 1 successfully reconciled and committed");

  // Attempt 2: Client retries with the SAME Idempotency-Key
  const res2 = await api("PATCH", `/user/bookings/${booking._id}/reschedule`, {
    token: tokenFor(student),
    headers: { "Idempotency-Key": idempotencyKey },
    body: { newScheduleId: String(scheduleB._id), newSlotId: "slot-1" },
  });

  assert.equal(res2.status, 200, "Retry must return 200 OK");
  assert.equal(res2.body.idempotent, true, "Retry must be identified as idempotent replay");

  // Verify seat was only decremented once
  const schedB = await schedulesCollection.findOne({ _id: scheduleB._id });
  assert.equal(schedB.timeSlots[0].slot, 4, "Slot counter must be decremented exactly once (4/5)");
});
