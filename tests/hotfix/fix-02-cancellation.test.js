"use strict";

/**
 * FIX-02a + FIX-02b acceptance tests — Day 3 (29 Oct 2026).
 *
 *   FIX-02a  DELETE /api/v1/bookings/:bookingId was reachable by any signed-in
 *            student and physically deleted the booking, restoring the mock
 *            credit. It is now admin-only and performs an atomic SOFT
 *            cancellation (`status: "cancelled"` + cancelledAt/cancelledBy),
 *            refused once attendance has been recorded, restoring the mock
 *            credit and (for Test Center bookings only) exactly one seat in the
 *            booked slot.
 *   FIX-02b  every query that means "active booking" excludes cancelled rows,
 *            while the administrative history endpoint still shows them.
 *   R07      pre-existing defect found while proving FIX-02b: the Test Center
 *            booking decrement bound its positional `$` wrongly (two array
 *            predicates), so it reduced the FIRST slot's availability instead of
 *            the booked one.
 *
 * TRANSACTIONS REQUIRE A REPLICA SET. The cancellation path uses a multi-
 * document transaction, so unlike the FIX-01/FIX-03/R01-R02 suites this one
 * cannot run against a standalone mongod ("Transaction numbers are only allowed
 * on a replica set member or mongos"). A single-node replica set on a loopback
 * port satisfies the shared safety harness unchanged: it is a writable primary
 * reached over `directConnection`, so no guard in tests/support/hotfixTestDb.js
 * is relaxed or bypassed for this suite.
 *
 * Run (throwaway data directory, never the installed 27017 service):
 *   mongod --dbpath <temp-dir> --port 27019 --bind_ip 127.0.0.1 --replSet rs0
 *   # one-time, then wait for promotion:
 *   rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27019" }] })
 *   set HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27019
 *   node --test tests/hotfix/fix-02-cancellation.test.js
 *
 * Safety contract (shared with the other hotfix suites):
 *   - HOTFIX_TEST_MONGODB_URI is mandatory, bare `mongodb://127.0.0.1:<port>`,
 *     never 27017;
 *   - direct connection, no client options, disposable `lumi_hotfix_test_*` db;
 *   - `.env` / `.env.test` are never loaded; synthetic `.invalid` accounts only;
 *   - no SMTP configuration is present, so `emailSender` short-circuits and no
 *     mail is ever sent (booking confirmation is best-effort/background).
 *
 * Every test builds its own student and (where seat arithmetic matters) its own
 * schedule, so no test depends on state left behind by another one.
 */

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
const {
  runSeatConsistencyAudit,
  asReadOnlyCollection,
} = require("../../scripts/audit-seat-consistency");

const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("fix02cancel");

stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;

const createApp = require("../../app");

const JWT_SECRET = process.env.JWT_SECRET;
const ATTENDED_PATTERN = /^(present|absent)$/i;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let client;
let db;
let usersCollection;
let schedulesCollection;
let bookingMockCollection;
let coursesCollection;
let server;
let baseUrl;

let adminA;
let adminB;
let bdm;
let teacher;
let capStudent;

const tokenFor = (user, overrides = {}) =>
  jwt.sign(
    { userId: String(user._id), role: user.role, email: user.email, ...overrides },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

async function api(method, path, { token, body } = {}) {
  const headers = { "X-Forwarded-For": "127.0.0.1" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
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

async function seedUser(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "Synthetic User",
    email: `user.${crypto.randomBytes(6).toString("hex")}@synthetic.invalid`,
    role: "user",
    status: "active",
    isDeleted: false,
    mock: 10,
    totalMock: 10,
    ...overrides,
  };
  await usersCollection.insertOne(doc);
  return doc;
}

/** A fresh student per test: no test may depend on another test's bookings. */
const newStudent = (overrides = {}) => seedUser({ name: "Synthetic Student", ...overrides });

/** A fresh schedule per seat-arithmetic test: exact slot numbers, no drift. */
async function newSchedule(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    courseId: new ObjectId().toHexString(),
    name: "Synthetic Schedule",
    startDate: "2026-04-10",
    endDate: "2026-04-10",
    status: "Scheduled",
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 5, totalSlot: 5 },
      { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 3, totalSlot: 3 },
    ],
    ...overrides,
  };
  await schedulesCollection.insertOne(doc);
  return doc;
}

/** Insert a booking directly: fixtures must not depend on the route under test. */
async function seedBooking(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    status: "pending",
    name: "IELTS",
    testType: "Academic",
    testSystem: "Computer-Based",
    location: "Home",
    bookingDate: "2026-04-01",
    testTime: "10:00",
    ...overrides,
  };
  assert.ok(doc.userId, "seedBooking requires an explicit userId");
  await bookingMockCollection.insertOne(doc);
  return doc;
}

async function seedCenterBooking({ student, schedule, slotId = "1", consumeSeat = true, ...overrides }) {
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Test Center",
    scheduleId: String(schedule._id),
    slotId,
    bookingDate: schedule.startDate,
    startTime: "09:00:00",
    endTime: "12:00:00",
    ...overrides,
  });

  // D3-R09 — a Test Center booking has already consumed a seat, so a fixture
  // that inserted the booking without decrementing the slot would model a state
  // production can never reach (and would make "restore one seat" look like an
  // oversell). Consume the seat exactly as POST /user/book-slot does, unless a
  // test deliberately needs an inconsistent counter (`consumeSeat: false`).
  if (consumeSeat && slotId !== undefined && slotId !== null && ObjectId.isValid(booking.scheduleId)) {
    await schedulesCollection.updateOne(
      {
        _id: new ObjectId(booking.scheduleId),
        timeSlots: { $elemMatch: { slotId, slot: { $gt: 0 } } },
      },
      { $inc: { "timeSlots.$.slot": -1 } }
    );
  }

  return booking;
}

const bookingById = (id) => bookingMockCollection.findOne({ _id: new ObjectId(id) });
const mockOf = async (user) => (await usersCollection.findOne({ _id: user._id })).mock;

async function slotMap(scheduleId) {
  const doc = await schedulesCollection.findOne({ _id: new ObjectId(scheduleId) });
  return Object.fromEntries((doc?.timeSlots || []).map((s) => [s.slotId, Number(s.slot)]));
}

const cancel = (bookingId, as = adminA) =>
  api("DELETE", `/bookings/${bookingId}`, { token: tokenFor(as) });

before(async () => {
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));
  usersCollection = db.collection("users");
  schedulesCollection = db.collection("schedules");
  bookingMockCollection = db.collection("bookingMock");
  coursesCollection = db.collection("courses");

  adminA = await seedUser({ name: "Synthetic Admin A", email: "admin.a@synthetic.invalid", role: "admin" });
  adminB = await seedUser({ name: "Synthetic Admin B", email: "admin.b@synthetic.invalid", role: "admin" });
  bdm = await seedUser({ name: "Synthetic BDM", email: "bdm.cancel@synthetic.invalid", role: "bdm" });
  teacher = await seedUser({ name: "Synthetic Teacher", email: "teacher.cancel@synthetic.invalid", role: "teacher" });

  // Owns a purchased single-mock entitlement: proves the per-course cap counts
  // ACTIVE bookings only.
  capStudent = await seedUser({
    name: "Synthetic Cap Student",
    email: "student.cap@synthetic.invalid",
    mock: 2,
    totalMock: 2,
    mockType: "IELTS",
    testType: "Academic",
    mocks: [{ mockType: "IELTS", testType: "Academic", mock: 1 }],
  });

  const app = createApp({
    usersCollection,
    coursesCollection,
    schedulesCollection,
    bookingMockCollection,
    client,
  });

  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) {
    try {
      if (db) await db.dropDatabase();
    } catch (err) {
      console.error("WARNING: could not drop disposable test database:", err.message);
    }
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// F2-01 — authorization: cancellation is admin-only
// ---------------------------------------------------------------------------

for (const [label, actorOf] of [
  ["a student", () => null],
  ["a BDM", () => bdm],
  ["a teacher", () => teacher],
]) {
  test(`F2-01 ${label} cannot cancel a booking (403, nothing changed)`, async () => {
    const student = await newStudent();
    const schedule = await newSchedule();
    const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
    const actor = actorOf() || student;

    const slotsBefore = await slotMap(schedule._id);
    const mockBefore = await mockOf(student);

    const res = await cancel(booking._id, actor);

    assert.equal(res.status, 403, `${label} must be refused by verifyAdmin`);

    const afterDoc = await bookingById(booking._id);
    assert.ok(afterDoc, "the booking must not be deleted");
    assert.equal(afterDoc.status, "pending", "status must be untouched");
    assert.equal(afterDoc.cancelledAt, undefined);
    assert.equal(afterDoc.cancelledBy, undefined);
    assert.equal(await mockOf(student), mockBefore, "no credit may be restored");
    assert.deepEqual(await slotMap(schedule._id), slotsBefore, "no seat may be restored");
  });
}

test("F2-01 unauthenticated cancellation is 401", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule });

  const res = await api("DELETE", `/bookings/${booking._id}`);
  assert.equal(res.status, 401);
  assert.equal((await bookingById(booking._id)).status, "pending");
});

// ---------------------------------------------------------------------------
// F2-02 — attendance protection
// ---------------------------------------------------------------------------

test("F2-02a an attended (present) booking cannot be cancelled or refunded", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({
    student,
    schedule,
    attendance: "present",
    status: "Present",
  });
  const mockBefore = await mockOf(student);
  const slotsBefore = await slotMap(schedule._id);

  const res = await cancel(booking._id);

  assert.equal(res.status, 409);
  const afterDoc = await bookingById(booking._id);
  assert.equal(afterDoc.status, "Present", "status must be untouched");
  assert.equal(afterDoc.attendance, "present");
  assert.equal(await mockOf(student), mockBefore);
  assert.deepEqual(await slotMap(schedule._id), slotsBefore);
});

test("F2-02b an attended (absent) booking cannot be cancelled or refunded", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({
    student,
    schedule,
    attendance: "absent",
    status: "Absent",
  });
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);

  assert.equal(res.status, 409);
  assert.equal((await bookingById(booking._id)).attendance, "absent");
  assert.equal(await mockOf(student), mockBefore);
});

test("F2-02c legacy capitalisation of attendance is also refused", async () => {
  // `status` doubles as the attendance mirror in this data model, and older rows
  // may carry either casing on either field.
  const student = await newStudent();
  const schedule = await newSchedule();
  const viaAttendance = await seedCenterBooking({ student, schedule, attendance: "Present" });
  const viaStatus = await seedCenterBooking({
    student,
    schedule,
    attendance: undefined,
    status: "Absent",
  });
  const mockBefore = await mockOf(student);

  for (const booking of [viaAttendance, viaStatus]) {
    const res = await cancel(booking._id);
    assert.equal(res.status, 409, "mixed-case attendance must still block cancellation");
    assert.equal((await bookingById(booking._id)).cancelledAt, undefined);
  }

  assert.equal(await mockOf(student), mockBefore, "no credit may be restored for either of them");
});

// ---------------------------------------------------------------------------
// F2-03 — successful soft cancellation, audit fields, exactly-once accounting
// ---------------------------------------------------------------------------

test("F2-03a cancelling a pending Home booking keeps the record and restores one credit", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-04-20",
  });
  const mockBefore = await mockOf(student);
  const slotsBefore = await slotMap(schedule._id);

  const res = await cancel(booking._id);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true,
    message: "Booking canceled successfully, and mock count restored",
  });

  const afterDoc = await bookingById(booking._id);
  assert.ok(afterDoc, "the booking must be retained, never deleted");
  assert.equal(afterDoc.status, "cancelled");
  assert.ok(afterDoc.cancelledAt instanceof Date, "cancelledAt must be a Date");
  assert.equal(afterDoc.cancelledBy, String(adminA._id), "cancelledBy is the authenticated admin id");
  assert.equal(afterDoc.userId, String(student._id), "ownership fields must be preserved");
  assert.equal(afterDoc.bookingDate, "2026-04-20", "booking data must be preserved");

  assert.equal(await mockOf(student), mockBefore + 1, "exactly one credit is restored");
  assert.deepEqual(await slotMap(schedule._id), slotsBefore, "Home bookings never touch capacity");
});

test("F2-03b cancelling a pending Test Center booking restores exactly one seat", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
  const mockBefore = await mockOf(student);

  assert.deepEqual(await slotMap(schedule._id), { "1": 4, "2": 3 }, "the booking has consumed one seat");

  const res = await cancel(booking._id);
  assert.equal(res.status, 200);

  const afterDoc = await bookingById(booking._id);
  assert.equal(afterDoc.status, "cancelled");
  assert.equal(afterDoc.slotId, "1", "slot linkage preserved for history");

  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5, "2": 3 },
    "exactly one seat returns to the booked slot and no other slot moves"
  );
  assert.equal(await mockOf(student), mockBefore + 1);
});

// ---------------------------------------------------------------------------
// F2-04 / F2-05 — duplicate and concurrent cancellation
// ---------------------------------------------------------------------------

test("F2-04 cancelling the same booking twice refunds only once", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "2" });
  const mockBefore = await mockOf(student);

  const first = await cancel(booking._id, adminA);
  assert.equal(first.status, 200);

  const mockAfterFirst = await mockOf(student);
  const slotsAfterFirst = await slotMap(schedule._id);

  const second = await cancel(booking._id, adminB);
  assert.equal(second.status, 409, "a second cancellation must be a conflict, not a second refund");

  assert.equal(await mockOf(student), mockAfterFirst, "no second credit");
  assert.deepEqual(await slotMap(schedule._id), slotsAfterFirst, "no second seat");

  assert.equal(mockAfterFirst, mockBefore + 1);
  assert.deepEqual(slotsAfterFirst, { "1": 5, "2": 3 });
  assert.equal(
    (await bookingById(booking._id)).cancelledBy,
    String(adminA._id),
    "audit keeps the admin who actually cancelled"
  );
});

test("F2-05 two admins cancelling concurrently refund exactly once", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
  const mockBefore = await mockOf(student);

  const [a, b] = await Promise.all([cancel(booking._id, adminA), cancel(booking._id, adminB)]);

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(
    statuses,
    [200, 409],
    `exactly one cancellation may win (got ${statuses.join(", ")})`
  );

  assert.equal(await mockOf(student), mockBefore + 1, "the credit is restored exactly once");
  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5, "2": 3 },
    "the seat is restored exactly once"
  );

  const afterDoc = await bookingById(booking._id);
  assert.equal(afterDoc.status, "cancelled");
  assert.ok(
    [String(adminA._id), String(adminB._id)].includes(afterDoc.cancelledBy),
    "cancelledBy must be one of the two admins that actually claimed it"
  );
});

// ---------------------------------------------------------------------------
// F2-06 — cancelled bookings disappear from active surfaces, stay in history
// ---------------------------------------------------------------------------

test("F2-06a cancelled bookings are not shown in the student booking list", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const live = await seedCenterBooking({ student, schedule, slotId: "1" });
  const cancelled = await seedCenterBooking({ student, schedule, slotId: "2" });

  assert.equal((await cancel(cancelled._id)).status, 200);

  const list = await api("GET", `/user/bookings/${student._id}`, { token: tokenFor(student) });
  assert.equal(list.status, 200);

  const ids = list.body.bookings.map((b) => String(b._id));
  assert.ok(ids.includes(String(live._id)), "active bookings remain visible to the student");
  assert.equal(ids.includes(String(cancelled._id)), false, "cancelled bookings must not be listed");
  assert.equal(
    list.body.bookings.some((b) => b.status === "cancelled"),
    false,
    "no cancelled row may leak into the student list"
  );
});

test("F2-06b cancelled bookings remain visible in administrative history", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
  assert.equal((await cancel(booking._id)).status, 200);

  const all = await api("GET", "/admin/bookings?limit=2000", { token: tokenFor(adminA) });
  assert.equal(all.status, 200);
  assert.ok(
    all.body.bookings.map((b) => String(b._id)).includes(String(booking._id)),
    "the audit list must retain cancelled bookings"
  );

  const onlyCancelled = await api("GET", "/admin/bookings?status=cancelled&limit=2000", {
    token: tokenFor(adminA),
  });
  assert.equal(onlyCancelled.status, 200);
  assert.ok(
    onlyCancelled.body.bookings.map((b) => String(b._id)).includes(String(booking._id)),
    "cancelled rows are queryable by status"
  );
  assert.equal(
    onlyCancelled.body.bookings.every((b) => b.status === "cancelled"),
    true,
    "the status filter must not leak active rows"
  );
});

test("F2-06c cancelled bookings are excluded from the operational rosters", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const homeLive = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-04-21",
  });
  const homeCancelled = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-04-22",
  });
  const centerCancelled = await seedCenterBooking({ student, schedule, slotId: "2" });

  for (const b of [homeCancelled, centerCancelled]) {
    assert.equal((await cancel(b._id)).status, 200);
  }

  const home = await api("GET", "/admin/bookings/home-with-users", { token: tokenFor(adminA) });
  assert.equal(home.status, 200);
  const homeIds = home.body.bookings.map((b) => String(b._id));
  assert.ok(homeIds.includes(String(homeLive._id)), "active Home bookings stay in the roster");
  assert.equal(
    homeIds.includes(String(homeCancelled._id)),
    false,
    "cancelled Home bookings leave the roster"
  );

  const bySchedule = await api(
    "GET",
    `/admin/bookings/by-schedule/${centerCancelled.scheduleId}?limit=2000`,
    { token: tokenFor(adminA) }
  );
  assert.equal(bySchedule.status, 200);
  assert.equal(
    bySchedule.body.bookings.map((b) => String(b._id)).includes(String(centerCancelled._id)),
    false,
    "cancelled bookings leave the schedule roster"
  );
});

// ---------------------------------------------------------------------------
// F2-07 — cancelling does not block a legitimate rebooking
// ---------------------------------------------------------------------------

test("F2-07a a cancelled Home booking no longer blocks that date", async () => {
  const student = await newStudent();
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-04-25",
  });
  assert.equal((await cancel(booking._id)).status, 200);

  const mockBefore = await mockOf(student);
  const rebook = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: {
      userId: String(student._id),
      location: "Home",
      bookingDate: "2026-04-25",
      testTime: "10:00",
      name: "IELTS",
      testType: "Academic",
    },
  });

  assert.equal(
    rebook.status,
    200,
    `rebooking the cancelled date must be allowed (got ${JSON.stringify(rebook.body)})`
  );
  assert.equal(rebook.body.success, true);
  assert.equal(await mockOf(student), mockBefore - 1, "the rebooking consumes one credit");
});

test("F2-07b a cancelled Test Center booking no longer blocks that slot", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "2" });
  assert.equal((await cancel(booking._id)).status, 200);

  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 }, "the seat came back");

  const rebook = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: {
      userId: String(student._id),
      location: "Test Center",
      scheduleId: String(schedule._id),
      slotId: "2",
      name: "IELTS",
      testType: "Academic",
      testSystem: "Computer-Based",
    },
  });

  assert.equal(
    rebook.status,
    200,
    `rebooking the cancelled slot must be allowed (got ${JSON.stringify(rebook.body)})`
  );
  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5, "2": 2 },
    "the rebooking consumes the restored seat from the correct slot"
  );
});

test("F2-07c the per-course entitlement cap counts active bookings only", async () => {
  // One purchased mock for IELTS/Academic. A cancelled booking for that course
  // must not count as "used", or the student could never use the entitlement.
  await seedBooking({
    userId: String(capStudent._id),
    location: "Home",
    bookingDate: "2026-04-26",
    status: "cancelled",
    cancelledAt: new Date(),
    cancelledBy: String(adminA._id),
  });

  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(capStudent),
    body: {
      userId: String(capStudent._id),
      location: "Home",
      bookingDate: "2026-04-27",
      testTime: "10:00",
      name: "IELTS",
      testType: "Academic",
    },
  });
  assert.equal(first.status, 200, "the cancelled booking must not consume the purchased mock");
  assert.equal(await mockOf(capStudent), 1);

  // Positive control: once that one appointment is active, the cap engages
  // again — the filter narrowed the count, it did not disable the rule.
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(capStudent),
    body: {
      userId: String(capStudent._id),
      location: "Home",
      bookingDate: "2026-04-28",
      testTime: "10:00",
      name: "IELTS",
      testType: "Academic",
    },
  });
  assert.equal(second.status, 400);
  assert.equal(second.body.message, "Insufficient mock tests available.");
});

// ---------------------------------------------------------------------------
// F2-08 — attendance and cancelled bookings
// ---------------------------------------------------------------------------

test("F2-08a a cancelled booking cannot receive a new attendance update", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
  assert.equal((await cancel(booking._id)).status, 200);

  const res = await api("PUT", `/user/bookings/${booking.scheduleId}`, {
    token: tokenFor(adminA),
    body: { userId: String(student._id), attendance: "present", status: "Present" },
  });

  assert.equal(res.status, 404, "the attendance update must not find a cancelled booking");
  const afterDoc = await bookingById(booking._id);
  assert.equal(afterDoc.status, "cancelled", "status must not be overwritten");
  assert.equal(afterDoc.attendance, undefined, "attendance must not be recorded");
});

test("F2-08b cancellation racing an attendance update leaves a consistent record", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "2" });
  const mockBefore = await mockOf(student);

  const [cancelRes, attendanceRes] = await Promise.all([
    cancel(booking._id),
    api("PUT", `/user/bookings/${booking.scheduleId}`, {
      token: tokenFor(adminA),
      body: { userId: String(student._id), attendance: "present", status: "Present" },
    }),
  ]);

  const doc = await bookingById(booking._id);
  const cancelled = doc.status === "cancelled";
  const attended =
    ATTENDED_PATTERN.test(String(doc.attendance || "")) ||
    ATTENDED_PATTERN.test(String(doc.status || ""));

  assert.equal(
    cancelled && attended,
    false,
    "a booking must never be both cancelled and attended (that would refund a sat test)"
  );
  assert.equal(
    cancelled || attended,
    true,
    `one of the two operations must have taken effect (cancel=${cancelRes.status}, attendance=${attendanceRes.status})`
  );

  const mockAfter = await mockOf(student);
  if (cancelled) {
    assert.equal(cancelRes.status, 200);
    assert.equal(mockAfter, mockBefore + 1, "a winning cancellation restores the credit");
  } else {
    assert.notEqual(cancelRes.status, 200, "a losing cancellation must not report success");
    assert.equal(mockAfter, mockBefore, "no credit is restored when attendance won");
  }
});

// ---------------------------------------------------------------------------
// F2-09 — input handling and rollback
// ---------------------------------------------------------------------------

test("F2-09a an invalid booking id is rejected", async () => {
  const res = await api("DELETE", "/bookings/not-an-object-id", { token: tokenFor(adminA) });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Invalid booking ID format.");
});

test("F2-09b a missing booking is 404", async () => {
  const res = await api("DELETE", `/bookings/${new ObjectId().toHexString()}`, {
    token: tokenFor(adminA),
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.message, "Booking not found.");
});

test("F2-09c a missing schedule/slot rolls the whole cancellation back", async () => {
  // Legacy bookings whose slot or schedule no longer exists: the seat cannot be
  // returned, so nothing at all may change.
  const student = await newStudent();
  const schedule = await newSchedule();
  const missingSlot = await seedCenterBooking({ student, schedule, slotId: "99" });
  const missingSchedule = await seedCenterBooking({
    student,
    schedule,
    scheduleId: new ObjectId().toHexString(),
  });

  const mockBefore = await mockOf(student);
  const slotsBefore = await slotMap(schedule._id);

  for (const booking of [missingSlot, missingSchedule]) {
    const res = await cancel(booking._id);
    assert.equal(res.status, 409, "an unreturnable seat is a known conflict, fully rolled back");

    const afterDoc = await bookingById(booking._id);
    assert.ok(afterDoc, "the booking must still exist");
    assert.equal(afterDoc.status, "pending", "the booking must not be left cancelled");
    assert.equal(afterDoc.cancelledAt, undefined);
  }

  assert.equal(await mockOf(student), mockBefore, "no credit is restored on a rolled-back cancel");
  assert.deepEqual(await slotMap(schedule._id), slotsBefore, "no seat is moved");
});

test("F2-09d a missing user document rolls the whole cancellation back", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const orphan = await seedCenterBooking({
    student,
    schedule,
    slotId: "1",
    userId: new ObjectId().toHexString(),
  });
  const slotsBefore = await slotMap(schedule._id);

  const res = await cancel(orphan._id);

  assert.equal(res.status, 500, "an unreadable owner is a server-side failure, not a conflict");

  const afterDoc = await bookingById(orphan._id);
  assert.equal(afterDoc.status, "pending", "the booking must not be cancelled without a refund");
  assert.equal(afterDoc.cancelledAt, undefined);
  assert.deepEqual(await slotMap(schedule._id), slotsBefore, "the seat restore must be rolled back");
});

// ---------------------------------------------------------------------------
// R07 — pre-existing seat-binding defect (found while proving F2-07b)
// ---------------------------------------------------------------------------

test("R07 a Test Center booking decrements the booked slot, not the first slot", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: {
      userId: String(student._id),
      location: "Test Center",
      scheduleId: String(schedule._id),
      slotId: "2",
      name: "IELTS",
      testType: "Academic",
      testSystem: "Computer-Based",
    },
  });

  assert.equal(res.status, 200, `booking must succeed (got ${JSON.stringify(res.body)})`);
  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5, "2": 2 },
    "only the booked slot loses a seat"
  );
});

test("R07 the atomic guard still refuses to oversell the last seat of the chosen slot", async () => {
  // The single-request pre-check rejects a zero-seat slot before the transaction
  // is opened, so the positional guard is exercised the way production exercises
  // it: two students racing for the last seat of slot "2". Exactly one may win,
  // and the winner must take the seat from slot "2" — never from slot "1".
  const schedule = await newSchedule({
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 5, totalSlot: 5 },
      { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 1, totalSlot: 1 },
    ],
  });
  const first = await newStudent();
  const second = await newStudent();

  const book = (student) =>
    api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: {
        userId: String(student._id),
        location: "Test Center",
        scheduleId: String(schedule._id),
        slotId: "2",
        name: "IELTS",
        testType: "Academic",
        testSystem: "Computer-Based",
      },
    });

  const [a, b] = await Promise.all([book(first), book(second)]);

  const won = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status !== 200);
  assert.equal(won.length, 1, `exactly one student may take the last seat (got ${a.status}/${b.status})`);
  assert.equal(lost.length, 1);
  assert.ok(
    [400, 409].includes(lost[0].status),
    `the loser must be refused as a conflict, not a server error (got ${lost[0].status})`
  );

  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5, "2": 0 },
    "the seat comes from the chosen slot only and never goes negative"
  );
  assert.equal(
    await bookingMockCollection.countDocuments({
      scheduleId: String(schedule._id),
      status: { $ne: "cancelled" },
    }),
    1,
    "exactly one booking may exist for the single seat"
  );
});

// ---------------------------------------------------------------------------
// Regression guards for the routes whose queries FIX-02b touched
// ---------------------------------------------------------------------------

test("F2-10 teacher assignment still works on an active Home booking and is refused when cancelled", async () => {
  const student = await newStudent();
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-04-29",
  });

  const ok = await api("PUT", `/admin/bookings/${booking._id}/teacher`, {
    token: tokenFor(adminA),
    body: { skill: "L", teacher: "Synthetic Teacher", email: "teacher.assign@synthetic.invalid" },
  });
  assert.equal(
    ok.status,
    200,
    `an active Home booking must still accept a teacher (got ${JSON.stringify(ok.body)})`
  );
  assert.equal(ok.body.booking.teacherL, "Synthetic Teacher");

  assert.equal((await cancel(booking._id)).status, 200);

  const refused = await api("PUT", `/admin/bookings/${booking._id}/teacher`, {
    token: tokenFor(adminA),
    body: { skill: "R", teacher: "Synthetic Teacher", email: "teacher.assign@synthetic.invalid" },
  });
  assert.equal(refused.status, 404, "a cancelled booking is no longer an assignment target");
});

test("F2-11 attendance still updates an active booking and the TRF status route still answers", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });

  const res = await api("PUT", `/user/bookings/${booking.scheduleId}`, {
    token: tokenFor(adminA),
    body: { userId: String(student._id), attendance: "present", status: "Present" },
  });
  assert.equal(res.status, 200, `attendance must still update (got ${JSON.stringify(res.body)})`);
  assert.equal(res.body.success, true);

  const afterDoc = await bookingById(booking._id);
  assert.equal(afterDoc.attendance, "present");
  assert.equal(afterDoc.status, "Present");

  const status = await api("GET", `/admin/trf-email-status/${student._id}/${booking.scheduleId}`, {
    token: tokenFor(adminA),
  });
  assert.equal(status.status, 200, "the TRF status lookup must keep answering");
  assert.equal(status.body.sent, false);
});

test("F2-12 the admin history endpoint keeps its existing 404-on-empty contract", async () => {
  const res = await api("GET", "/admin/bookings?status=definitely-no-such-status", {
    token: tokenFor(adminA),
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.message, "No bookings found");
});

// ---------------------------------------------------------------------------
// D3-R08 — a Test Center booking must prove its seat before it is cancelled
// ---------------------------------------------------------------------------

const unsetBookingFields = (bookingId, fields) =>
  bookingMockCollection.updateOne(
    { _id: new ObjectId(bookingId) },
    { $unset: Object.fromEntries(fields.map((field) => [field, ""])) }
  );

/** A 409 must leave *everything* exactly as it was. */
async function expectRefusedIntact({
  res,
  booking,
  student,
  schedule,
  slotsBefore,
  mockBefore,
  label,
}) {
  assert.equal(
    res.status,
    409,
    `${label}: expected a controlled conflict, got ${res.status} (${JSON.stringify(res.body)})`
  );
  const afterDoc = await bookingById(booking._id);
  assert.ok(afterDoc, `${label}: the booking record must survive`);
  assert.equal(afterDoc.status, "pending", `${label}: the booking must stay active`);
  assert.equal(afterDoc.cancelledAt, undefined, `${label}: no cancellation stamp may be written`);
  assert.equal(afterDoc.cancelledBy, undefined, `${label}: no cancellation stamp may be written`);
  assert.equal(await mockOf(student), mockBefore, `${label}: no mock credit may be refunded`);
  if (schedule) {
    assert.deepEqual(
      await slotMap(schedule._id),
      slotsBefore,
      `${label}: no seat may move`
    );
  }
}

// Each row: how the Test Center booking's link to its seat is broken.
for (const [label, mutate] of [
  ["scheduleId is absent", async (booking) => unsetBookingFields(booking._id, ["scheduleId"])],
  ["slotId is absent", async (booking) => unsetBookingFields(booking._id, ["slotId"])],
]) {
  test(`D3-R08a a Test Center booking whose ${label} is refused and fully rolled back`, async () => {
    const student = await newStudent();
    const schedule = await newSchedule();
    const booking = await seedCenterBooking({
      student,
      schedule,
      slotId: "1",
      consumeSeat: false,
    });
    await mutate(booking);

    const slotsBefore = await slotMap(schedule._id);
    const mockBefore = await mockOf(student);

    const res = await cancel(booking._id);
    await expectRefusedIntact({ res, booking, student, schedule, slotsBefore, mockBefore, label });
    assert.match(res.body.message, /missing its schedule or time slot reference/i);
  });
}

test("D3-R08b a malformed schedule reference is refused, not a server error", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({
    student,
    schedule,
    slotId: "1",
    scheduleId: "not-an-object-id",
    consumeSeat: false,
  });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);
  await expectRefusedIntact({
    res,
    booking,
    student,
    schedule,
    slotsBefore,
    mockBefore,
    label: "malformed scheduleId",
  });
  assert.match(res.body.message, /invalid schedule reference/i);
});

test("D3-R08c an orphaned schedule reference is refused", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({
    student,
    schedule,
    slotId: "1",
    scheduleId: new ObjectId().toHexString(),
    consumeSeat: false,
  });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);
  await expectRefusedIntact({
    res,
    booking,
    student,
    schedule,
    slotsBefore,
    mockBefore,
    label: "orphaned schedule",
  });
  assert.match(res.body.message, /schedule for this booking no longer exists/i);
});

test("D3-R08d an orphaned slot reference is refused", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({ student, schedule, slotId: "99" });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);
  await expectRefusedIntact({
    res,
    booking,
    student,
    schedule,
    slotsBefore,
    mockBefore,
    label: "orphaned slot",
  });
  assert.match(res.body.message, /time slot for this booking no longer exists/i);
});

test("D3-R08e an ambiguous slot reference is refused rather than guessing", async () => {
  const student = await newStudent();
  const schedule = await newSchedule({
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 4, totalSlot: 5 },
      { slotId: "1", startTime: "13:00:00", endTime: "16:00:00", slot: 2, totalSlot: 3 },
    ],
  });
  const booking = await seedCenterBooking({
    student,
    schedule,
    slotId: "1",
    consumeSeat: false,
  });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);
  await expectRefusedIntact({
    res,
    booking,
    student,
    schedule,
    slotsBefore,
    mockBefore,
    label: "ambiguous slotId",
  });
  assert.match(res.body.message, /matches more than one slot/i);
});

test("D3-R08f a Test Center booking is never silently treated as a Home booking", async () => {
  // Same booking, link removed: the old code refunded the credit because
  // "no linkage" was inferred to mean "Home". It must refuse instead.
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedCenterBooking({
    student,
    schedule,
    slotId: "1",
    consumeSeat: false,
  });
  await unsetBookingFields(booking._id, ["scheduleId", "slotId"]);

  const mockBefore = await mockOf(student);
  const res = await cancel(booking._id);

  assert.equal(res.status, 409);
  assert.equal(await mockOf(student), mockBefore, "the credit must NOT be refunded");
  assert.equal((await bookingById(booking._id)).status, "pending");
});

test("D3-R08g a Home booking without any seat linkage still cancels and refunds", async () => {
  const student = await newStudent();
  const schedule = await newSchedule();
  const booking = await seedBooking({
    userId: String(student._id),
    location: "Home",
    bookingDate: "2026-05-01",
  });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);

  assert.equal(res.status, 200, `Home cancellation must keep working (${JSON.stringify(res.body)})`);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "Booking canceled successfully, and mock count restored");
  assert.equal((await bookingById(booking._id)).status, "cancelled");
  assert.equal(await mockOf(student), mockBefore + 1, "Home still refunds the credit");
  assert.deepEqual(await slotMap(schedule._id), slotsBefore, "Home never touches capacity");
});

for (const [label, location] of [
  ["an unrecognised location", "Online"],
  ["a missing location", undefined],
]) {
  test(`D3-R08h a booking with ${label} is refused instead of assumed Home`, async () => {
    const student = await newStudent();
    const booking = await seedBooking({
      userId: String(student._id),
      location: "Home",
      bookingDate: "2026-05-02",
    });
    if (location === undefined) {
      await unsetBookingFields(booking._id, ["location"]);
    } else {
      await bookingMockCollection.updateOne({ _id: booking._id }, { $set: { location } });
    }
    const mockBefore = await mockOf(student);

    const res = await cancel(booking._id);

    assert.equal(res.status, 409, `${label} must not be cancelled (${JSON.stringify(res.body)})`);
    assert.match(res.body.message, /no recognised location/i);
    assert.equal(await mockOf(student), mockBefore);
    assert.equal((await bookingById(booking._id)).status, "pending");
  });
}

// ---------------------------------------------------------------------------
// D3-R09 — capacity-safe seat restoration
// ---------------------------------------------------------------------------

for (const [label, slot, message] of [
  [
    "an already-full slot",
    { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 5, totalSlot: 5 },
    /already at or above its configured capacity/i,
  ],
  [
    "a slot above its configured capacity",
    { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 6, totalSlot: 5 },
    /already at or above its configured capacity/i,
  ],
]) {
  test(`D3-R09a ${label} cannot be restored into, and nothing changes`, async () => {
    const student = await newStudent();
    const schedule = await newSchedule({ timeSlots: [slot] });
    const booking = await seedCenterBooking({
      student,
      schedule,
      slotId: "1",
      consumeSeat: false,
    });
    const slotsBefore = await slotMap(schedule._id);
    const mockBefore = await mockOf(student);

    const res = await cancel(booking._id);
    await expectRefusedIntact({
      res,
      booking,
      student,
      schedule,
      slotsBefore,
      mockBefore,
      label,
    });
    assert.match(res.body.message, message);
    const seatsAfter = (await slotMap(schedule._id))["1"];
    assert.ok(
      seatsAfter <= slotsBefore["1"],
      "a refused cancellation must never increase availability"
    );
  });
}

for (const [label, slot] of [
  ["a missing totalSlot", { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 3 }],
  [
    "a string seat counter",
    { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: "4", totalSlot: 5 },
  ],
  [
    "a negative seat counter",
    { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: -1, totalSlot: 5 },
  ],
  [
    "a fractional capacity",
    { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 1, totalSlot: 2.5 },
  ],
]) {
  test(`D3-R09b ${label} is rejected safely (no invented default capacity)`, async () => {
    const student = await newStudent();
    const schedule = await newSchedule({ timeSlots: [slot] });
    const booking = await seedCenterBooking({
      student,
      schedule,
      slotId: "1",
      consumeSeat: false,
    });
    const slotsBefore = await slotMap(schedule._id);
    const mockBefore = await mockOf(student);

    const res = await cancel(booking._id);
    await expectRefusedIntact({
      res,
      booking,
      student,
      schedule,
      slotsBefore,
      mockBefore,
      label,
    });
    assert.match(res.body.message, /seat counters .* missing or invalid/i);
  });
}

test("D3-R09c a healthy Test Center cancellation restores exactly one seat and one credit", async () => {
  const student = await newStudent();
  const schedule = await newSchedule({
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 4, totalSlot: 6 },
      { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 1, totalSlot: 2 },
      { slotId: "3", startTime: "17:00:00", endTime: "19:00:00", slot: 0, totalSlot: 2 },
    ],
  });
  const booking = await seedCenterBooking({ student, schedule, slotId: "1" });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);
  assert.deepEqual(slotsBefore, { "1": 3, "2": 1, "3": 0 });

  const res = await cancel(booking._id);

  assert.equal(res.status, 200, `healthy cancellation must succeed (${JSON.stringify(res.body)})`);
  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 4, "2": 1, "3": 0 },
    "only the booked slot gains its seat back"
  );
  assert.equal(await mockOf(student), mockBefore + 1, "exactly one credit is restored");
  assert.equal((await bookingById(booking._id)).status, "cancelled");
});

test("D3-R09d historical cross-slot drift blocks only the affected slot", async () => {
  // Slot "1" is healthy, slot "2" carries the direction the R07 defect pushed
  // (availability already at capacity). Cancelling the slot-2 booking must not
  // compound the drift, and must not disturb the healthy slot either.
  const student = await newStudent();
  const schedule = await newSchedule({
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 2, totalSlot: 5 },
      { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 5, totalSlot: 5 },
    ],
  });
  const booking = await seedCenterBooking({
    student,
    schedule,
    slotId: "2",
    consumeSeat: false,
  });
  const slotsBefore = await slotMap(schedule._id);
  const mockBefore = await mockOf(student);

  const res = await cancel(booking._id);

  await expectRefusedIntact({
    res,
    booking,
    student,
    schedule,
    slotsBefore,
    mockBefore,
    label: "cross-slot drift",
  });
  assert.deepEqual(await slotMap(schedule._id), { "1": 2, "2": 5 });
  assert.ok(res.status === 409);
});

test("D3-R09e two cancellations racing for the same slot never double-count a seat", async () => {
  const schedule = await newSchedule({
    timeSlots: [{ slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 3, totalSlot: 5 }],
  });
  const firstStudent = await newStudent();
  const secondStudent = await newStudent();
  const first = await seedCenterBooking({
    student: firstStudent,
    schedule,
    slotId: "1",
    consumeSeat: false,
  });
  const second = await seedCenterBooking({
    student: secondStudent,
    schedule,
    slotId: "1",
    consumeSeat: false,
  });
  const mockBefore = [await mockOf(firstStudent), await mockOf(secondStudent)];

  const results = await Promise.all([cancel(first._id), cancel(second._id)]);
  const won = results.filter((r) => r.status === 200).length;

  for (const res of results) {
    assert.ok(
      res.status === 200 || res.status === 409,
      `a racing cancellation must be a success or a conflict, got ${res.status}`
    );
  }
  assert.ok(won >= 1, "at least one cancellation must succeed");

  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 3 + won },
    "each success returns exactly one seat — never two for one booking"
  );
  assert.equal(
    await mockOf(firstStudent),
    mockBefore[0] + (results[0].status === 200 ? 1 : 0),
    "the first student's credit follows their own outcome"
  );
  assert.equal(
    await mockOf(secondStudent),
    mockBefore[1] + (results[1].status === 200 ? 1 : 0),
    "the second student's credit follows their own outcome"
  );

  // A 409 is a safe conflict: nothing changed, so a retry must then succeed.
  for (const [index, res] of results.entries()) {
    if (res.status !== 409) continue;
    const retry = await cancel(index === 0 ? first._id : second._id);
    assert.equal(retry.status, 200, "a conflicted cancellation must be retryable");
  }
  assert.deepEqual(
    await slotMap(schedule._id),
    { "1": 5 },
    "after both cancellations each seat is restored exactly once"
  );
});

// ---------------------------------------------------------------------------
// D3-R09 — read-only historical consistency audit
// ---------------------------------------------------------------------------

test("D3-A1 the audit cannot write: only find() is reachable on the wrapped collection", async () => {
  const calls = [];
  const stub = {
    find: () => ({ toArray: async () => [{ ok: 1 }] }),
    findOne: () => calls.push("findOne"),
    aggregate: () => calls.push("aggregate"),
    insertOne: () => calls.push("insertOne"),
    updateOne: () => calls.push("updateOne"),
    deleteMany: () => calls.push("deleteMany"),
    drop: () => calls.push("drop"),
  };
  const wrapped = asReadOnlyCollection(stub, "stub");

  // D3-R12: the facade exposes only find(); every other operation is absent, so
  // there is no route to the driver and nothing to reflect into.
  assert.deepEqual(await wrapped.find().toArray(), [{ ok: 1 }]);
  for (const method of ["findOne", "aggregate", "insertOne", "updateOne", "deleteMany", "drop"]) {
    assert.equal(wrapped[method], undefined, `${method} must be absent`);
    assert.throws(() => wrapped[method]({}), TypeError, `${method} call must fail`);
  }
  assert.deepEqual(calls, [], "no operation other than find may reach the collection");
});

test("D3-A2 the audit reports synthetic historical seat discrepancies and mutates nothing", async () => {
  const auditDbName = disposableDbName("seataudit");
  const { client: auditClient, db: auditDb } = await connectDisposable(
    SAFE_LOOPBACK_URI,
    auditDbName
  );

  try {
    const schedules = auditDb.collection("schedules");
    const bookings = auditDb.collection("bookingMock");

    const consistentSchedule = new ObjectId();
    const driftSchedule = new ObjectId();
    const duplicateSlotSchedule = new ObjectId();

    await schedules.insertMany([
      {
        _id: consistentSchedule,
        status: "Scheduled",
        timeSlots: [
          { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 3, totalSlot: 5 },
        ],
      },
      {
        _id: driftSchedule,
        status: "Scheduled",
        timeSlots: [
          // one active booking, so 4 is expected but 5 is recorded (R07 direction)
          { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 5, totalSlot: 5 },
          // no bookings, so 4 is expected but only 1 is recorded
          { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 1, totalSlot: 4 },
        ],
      },
      {
        _id: duplicateSlotSchedule,
        status: "Scheduled",
        timeSlots: [
          { slotId: "7", startTime: "09:00:00", endTime: "12:00:00", slot: 2, totalSlot: 3 },
          { slotId: "7", startTime: "13:00:00", endTime: "16:00:00", slot: 1, totalSlot: 3 },
          // missing totalSlot: unusable, must be reported, never defaulted
          { slotId: "8", startTime: "17:00:00", endTime: "19:00:00", slot: 2 },
        ],
      },
    ]);

    await bookings.insertMany([
      // 2 active bookings on the consistent slot: 5 - 2 = 3 recorded => consistent
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(consistentSchedule),
        slotId: "1",
      },
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(consistentSchedule),
        slotId: "1",
      },
      // a cancelled row must NOT count towards capacity
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "cancelled",
        scheduleId: String(consistentSchedule),
        slotId: "1",
      },
      // drives the drift on the second schedule
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(driftSchedule),
        slotId: "1",
      },
      // unlinkable: no slotId
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(consistentSchedule),
      },
      // unlinkable: schedule does not exist
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: new ObjectId().toHexString(),
        slotId: "1",
      },
      // unlinkable: slot does not exist on the schedule
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(consistentSchedule),
        slotId: "99",
      },
      // ambiguous: two schedule slots share slotId "7"
      {
        _id: new ObjectId(),
        location: "Test Center",
        status: "pending",
        scheduleId: String(duplicateSlotSchedule),
        slotId: "7",
      },
      // unrecognised location: cancellable no longer, must be surfaced
      { _id: new ObjectId(), location: "Online", status: "pending" },
    ]);

    const snapshot = async () => {
      const [scheduleDocs, bookingDocs] = await Promise.all([
        auditDb.collection("schedules").find({}).sort({ _id: 1 }).toArray(),
        auditDb.collection("bookingMock").find({}).sort({ _id: 1 }).toArray(),
      ]);
      return JSON.stringify({ scheduleDocs, bookingDocs });
    };

    const before = await snapshot();

    const report = await runSeatConsistencyAudit({
      bookingMockCollection: auditDb.collection("bookingMock"),
      schedulesCollection: auditDb.collection("schedules"),
      sampleLimit: 25,
    });

    const after = await snapshot();
    assert.equal(after, before, "the audit must not modify any document");

    assert.equal(report.readOnly, true);
    assert.deepEqual(report.totals, {
      schedulesScanned: 3,
      slotsScanned: 6,
      bookingsScanned: 9,
      activeBookings: 8,
      cancelledBookings: 1,
    });

    // Structural faults: confirmed integrity errors.
    assert.equal(report.issueCounts.invalidSlotRecords, 1, "slot without totalSlot");
    assert.equal(report.issueCounts.duplicateSlotIds, 1, "duplicate slotId within one schedule");
    assert.equal(report.issueCounts.unlinkableCenterBookings, 3);
    assert.equal(report.issueCounts.ambiguousCenterBookings, 1);
    assert.equal(report.issueCounts.unrecognisedLocationBookings, 1);

    // Arithmetic drift: uncertain discrepancies, not declared corruption.
    assert.equal(report.issueCounts.capacityMismatches, 2);
    assert.equal(report.summary.uncertainDiscrepancies, 2);

    // The consistent slot must not be flagged at all, which is only true if the
    // cancelled booking was excluded from the active count.
    assert.equal(
      report.issues.capacityMismatches.some((m) => m.scheduleRef === String(consistentSchedule)),
      false,
      "a consistent slot with a cancelled booking must not be flagged"
    );

    const r07Direction = report.issues.capacityMismatches.find(
      (m) => m.scheduleRef === String(driftSchedule) && m.slotId === "1"
    );
    assert.ok(r07Direction, "the over-recorded slot must be flagged");
    assert.equal(r07Direction.availableSeats, 5);
    assert.equal(r07Direction.activeBookings, 1);
    assert.equal(r07Direction.expectedAvailable, 4);
    assert.equal(r07Direction.delta, 1);
    assert.equal(r07Direction.possibleR07Drift, true);
    assert.equal(r07Direction.blocksCancellation, true);
    assert.equal(report.summary.cancellationBlockedSlots, 1);

    const underRecorded = report.issues.capacityMismatches.find(
      (m) => m.scheduleRef === String(driftSchedule) && m.slotId === "2"
    );
    assert.equal(underRecorded.delta, -3);
    assert.equal(underRecorded.possibleR07Drift, false);

    assert.equal(report.summary.confirmedIntegrityErrors, 7);

    // No student identity may leak into the report.
    const serialized = JSON.stringify(report);
    for (const forbidden of ["name", "email", "userId", "student"]) {
      assert.equal(
        serialized.includes(`"${forbidden}"`),
        false,
        `the report must not contain a "${forbidden}" field`
      );
    }
  } finally {
    try {
      await auditDb.dropDatabase();
    } finally {
      await auditClient.close();
    }
  }
});
