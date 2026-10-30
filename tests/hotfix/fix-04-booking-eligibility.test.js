"use strict";

/**
 * FIX-04 acceptance tests — Day 4 (30 Oct 2026).
 *
 * Covers the client checklist 4.1-4.13 plus the security additions agreed on
 * Day 4, for `POST /api/v1/user/book-slot`:
 *
 *   - strict Dhaka (UTC+06:00) date/time parsing and the 24-hour lead time;
 *   - past-test prohibition for every caller;
 *   - verified-admin exception to the lead time only;
 *   - `status === "completed"` enforced on the TARGET student;
 *   - server-authoritative course identity (Home: course document,
 *     Test Center: the schedule's own course document + test type);
 *   - MR validity evaluated at the scheduled test start;
 *   - renewal-aware, earliest-expiry-first allocation with no carry-over of
 *     expired unused capacity;
 *   - cancelled bookings excluded from entitlement usage;
 *   - FAIL-CLOSED behaviour when MR evidence is missing or malformed;
 *   - transaction-consistent approval/entitlement revalidation and atomic
 *     credit + seat claims, including concurrency on the final credit and the
 *     final seat.
 *
 * Two test groups live in this file:
 *   A. pure unit tests of `utils/bookingEligibility.js` — exact 24-hour and
 *      expiry boundaries, renewal arithmetic, fail-closed reasons. No database.
 *   B. HTTP integration tests against a real disposable MongoDB replica set
 *      (transactions are required), using the shared safety harness unchanged.
 *
 * TRANSACTIONS REQUIRE A REPLICA SET. Run (throwaway data directory, never the
 * installed 27017 service):
 *   mongod --dbpath <temp-dir> --port 27019 --bind_ip 127.0.0.1 --replSet rs0
 *   rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27019" }] })
 *   set HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27019
 *   node --test tests/hotfix/fix-04-booking-eligibility.test.js
 *
 * Safety contract (shared with the other hotfix suites):
 *   - HOTFIX_TEST_MONGODB_URI is mandatory, bare `mongodb://127.0.0.1:<port>`,
 *     never 27017; `.env` / `.env.test` are never loaded;
 *   - disposable `lumi_hotfix_test_*` database, dropped afterwards;
 *   - synthetic `.invalid` accounts only — no real student or teacher data;
 *   - no SMTP configuration exists, so no mail can leave the machine. The
 *     confirmation path is additionally wrapped by an invocation counter below,
 *     which is how "no email on a rejected booking" is asserted for real.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const {
  resolveTestMongoUri,
  disposableDbName,
  stripInheritedMongoEnv,
  connectDisposable,
} = require("../support/hotfixTestDb");

const eligibility = require("../../utils/bookingEligibility");
const UTIL_PATH = require.resolve("../../utils/bookingEligibility");

const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("fix04elig");

stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;

// Count confirmation-email attempts. The route destructures `emailSender` at
// module load, so the patch must be installed before `app` is required.
const emailModule = require("../../emailSender");
const realEmailSender = emailModule.emailSender;
let emailInvocations = 0;
emailModule.emailSender = async (...args) => {
  emailInvocations += 1;
  return realEmailSender(...args);
};

const createApp = require("../../app");

const JWT_SECRET = process.env.JWT_SECRET;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

// --- time helpers (Dhaka wall clock, independent of the runner's timezone) ---

/** A Dhaka wall-clock date string N days from now. */
const dhakaDateIn = (days) =>
  new Date(Date.now() + days * 24 * HOUR_MS + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

/** An ISO instant N days from now (explicit Z). */
const dhakaIsoIn = (days) => new Date(Date.now() + days * 24 * HOUR_MS).toISOString();

/** Dhaka wall-clock { date, time } at `hours` from now, truncated to the minute. */
const dhakaAtHours = (hours) => {
  const iso = new Date(Date.now() + hours * HOUR_MS + DHAKA_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

// --- fixtures ---------------------------------------------------------------

let ieltsCourse;
let greCourse;
let pteCourse;

async function seedCourse(name, overrides = {}) {
  const doc = { _id: new ObjectId(), name, ...overrides };
  await coursesCollection.insertOne(doc);
  return doc;
}

async function seedUser(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "Synthetic User",
    email: `user.${crypto.randomBytes(6).toString("hex")}@synthetic.invalid`,
    role: "user",
    status: "completed",
    isDeleted: false,
    mock: 0,
    totalMock: 0,
    ...overrides,
  };
  await usersCollection.insertOne(doc);
  return doc;
}

/** An MR row. Defaults to a valid, far-future IELTS / Computer-Based entitlement. */
const mr = (overrides = {}) => ({
  mockType: "IELTS",
  testType: "Computer-Based",
  testSystem: "Academic",
  mock: 3,
  transactionId: `MR-${crypto.randomBytes(6).toString("hex")}`,
  mrValidation: "6 months",
  mrValidationExpiry: dhakaIsoIn(180),
  createdAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
  ...overrides,
});

/** A student whose `mock` balance matches the MR rows they hold. */
const studentWith = (mocks = [], overrides = {}) => {
  const capacity = mocks.reduce((sum, m) => sum + (Number(m && m.mock) || 0), 0);
  return seedUser({ mocks, mock: capacity, totalMock: capacity, ...overrides });
};

/** A student who may book: approved, five credits and a valid MR row. */
const bookableStudent = async (overrides = {}) => {
  const row = mr({ mock: 5 });
  return studentWith([row], {
    mock: Number(row.mock),
    totalMock: Number(row.mock),
    ...overrides,
  });
};

async function seedSchedule(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    courseId: String(ieltsCourse._id),
    name: "IELTS",
    startDate: dhakaDateIn(7),
    endDate: dhakaDateIn(7),
    status: "Scheduled",
    testType: "Computer-Based",
    testSystem: "",
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 5, totalSlot: 5 },
      { slotId: "2", startTime: "13:00:00", endTime: "16:00:00", slot: 3, totalSlot: 3 },
    ],
    ...overrides,
  };
  await schedulesCollection.insertOne(doc);
  return doc;
}

const seedBooking = async (overrides = {}) => {
  const doc = {
    _id: new ObjectId(),
    status: "pending",
    name: "IELTS",
    testType: "Computer-Based",
    testSystem: "Academic",
    location: "Home",
    bookingDate: "2026-02-01",
    testTime: "10:00",
    ...overrides,
  };
  await bookingMockCollection.insertOne(doc);
  return doc;
};

const mockOf = async (user) => (await usersCollection.findOne({ _id: user._id })).mock;
const statusOf = async (user) => (await usersCollection.findOne({ _id: user._id })).status;
const slotMap = async (scheduleId) => {
  const doc = await schedulesCollection.findOne({ _id: new ObjectId(scheduleId) });
  return Object.fromEntries(doc.timeSlots.map((s) => [s.slotId, s.slot]));
};
const bookingCount = (userId) =>
  bookingMockCollection.countDocuments({ userId: String(userId), status: { $ne: "cancelled" } });

const homeBody = (student, overrides = {}) => ({
  userId: String(student._id),
  location: "Home",
  bookingDate: dhakaDateIn(7),
  testTime: "10:00",
  name: "IELTS",
  testType: "Computer-Based",
  ...overrides,
});

const centerBody = (student, schedule, slotId = "1", overrides = {}) => ({
  userId: String(student._id),
  location: "Test Center",
  scheduleId: String(schedule._id),
  slotId,
  name: "IELTS",
  testType: "Computer-Based",
  testSystem: "Academic",
  ...overrides,
});

before(async () => {
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));
  usersCollection = db.collection("users");
  schedulesCollection = db.collection("schedules");
  bookingMockCollection = db.collection("bookingMock");
  coursesCollection = db.collection("courses");

  ieltsCourse = await seedCourse("IELTS", { homeBasedSystems: ["Computer-Based"] });
  greCourse = await seedCourse("GRE", { homeBasedSystems: [] });
  pteCourse = await seedCourse("Pearson PTE", { homeBasedSystems: ["Computer-Based"] });

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

// ===========================================================================
// GROUP A — pure eligibility primitives (no database)
// ===========================================================================

const {
  parseDhakaDateTime,
  evaluateLeadTime,
  evaluateEntitlement,
  normalizeCourseName,
  normalizeMode,
  parseExpiryInstant,
  parsePurchaseInstant,
  parseExplicitInstant,
  parseMockQuantity,
  isWholeCreditBalance,
} = eligibility;

const at = (date, time) => {
  const parsed = parseDhakaDateTime(date, time);
  assert.equal(parsed.ok, true, `expected ${date} ${time} to parse`);
  return parsed.ms;
};

test("U-01 a Dhaka wall-clock time maps to the exact UTC instant (UTC+06:00)", () => {
  assert.equal(at("2026-12-01", "10:00"), Date.UTC(2026, 11, 1, 4, 0, 0, 0));
  assert.equal(at("2026-12-01", "00:00"), Date.UTC(2026, 11, 1, 0, 0, 0, 0) - 6 * HOUR_MS);
  assert.equal(at("2026-12-01", "23:59"), Date.UTC(2026, 11, 1, 17, 59, 0, 0));
  // Midnight Dhaka is the previous UTC day, which is exactly the boundary a
  // server-local parse gets wrong.
  assert.equal(new Date(at("2026-12-01", "00:00")).toISOString(), "2026-11-30T18:00:00.000Z");
});

test("U-02 the parser is timezone-independent (UTC process vs Asia/Dhaka process)", () => {
  const script = `
    const { parseDhakaDateTime } = require(${JSON.stringify(UTIL_PATH)});
    process.stdout.write(String(parseDhakaDateTime("2026-12-01", "10:00").ms));
  `;
  const run = (tz) =>
    execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
  assert.equal(run("UTC"), run("Asia/Dhaka"), "same wall-clock must not depend on the server TZ");
  assert.equal(Number(run("UTC")), Date.UTC(2026, 11, 1, 4, 0, 0, 0));
  assert.equal(Number(run("America/New_York")), Date.UTC(2026, 11, 1, 4, 0, 0, 0));
});

test("U-03 impossible calendar dates are rejected", () => {
  for (const bad of ["2026-13-40", "2026-02-30", "2026-00-10", "2026-04-31", "2026-4-1", "", "abc", "2026-04-01T00:00"]) {
    const parsed = parseDhakaDateTime(bad, "10:00");
    assert.equal(parsed.ok, false, `${bad} must be rejected`);
    assert.equal(parsed.reason, "invalid-date");
  }
  // A leap day that really exists must still pass.
  assert.equal(parseDhakaDateTime("2024-02-29", "10:00").ok, true);
});

test("U-04 impossible clock times are rejected, HH / HH:mm / HH:mm:ss accepted", () => {
  assert.equal(parseDhakaDateTime("2026-12-01", "10").ok, true);
  assert.equal(parseDhakaDateTime("2026-12-01", "10:30").ok, true);
  assert.equal(parseDhakaDateTime("2026-12-01", "10:30:45").ok, true);
  for (const bad of ["24:00", "12:60", "12:00:60", "1230", "", "10:3", "-1:00"]) {
    const parsed = parseDhakaDateTime("2026-12-01", bad);
    assert.equal(parsed.ok, false, `${bad} must be rejected`);
    assert.equal(parsed.reason, "invalid-time");
  }
});

test("U-05 the 24-hour boundary is inclusive at exactly 24h", () => {
  const start = at("2026-12-01", "10:00");
  assert.equal(evaluateLeadTime({ testStartMs: start, nowMs: start - HOUR_MS * 24 }).ok, true);
  assert.equal(evaluateLeadTime({ testStartMs: start, nowMs: start - HOUR_MS * 24 + 1 }).ok, false);
  assert.equal(
    evaluateLeadTime({ testStartMs: start, nowMs: start - HOUR_MS * 24 + 1 }).reason,
    "lead-time"
  );
  assert.equal(evaluateLeadTime({ testStartMs: start, nowMs: start - 23 * HOUR_MS }).reason, "lead-time");
});

test("U-06 a past test is refused for everyone, and the admin exception is lead-time only", () => {
  const start = at("2026-12-01", "10:00");
  assert.equal(evaluateLeadTime({ testStartMs: start, nowMs: start }).reason, "past");
  assert.equal(evaluateLeadTime({ testStartMs: start, nowMs: start + 1 }).reason, "past");
  assert.equal(
    evaluateLeadTime({ testStartMs: start, nowMs: start + 1, isVerifiedAdmin: true }).reason,
    "past",
    "an admin may not book a test that has already started"
  );
  assert.equal(
    evaluateLeadTime({ testStartMs: start, nowMs: start - HOUR_MS, isVerifiedAdmin: true }).ok,
    true,
    "an admin may book inside 24 hours"
  );
});

test("U-07 course normalisation: PTE === Pearson PTE, case and whitespace insensitive", () => {
  assert.equal(normalizeCourseName("PTE"), "pearson pte");
  assert.equal(normalizeCourseName(" pte "), "pearson pte");
  assert.equal(normalizeCourseName("Pearson   PTE"), "pearson pte");
  assert.equal(normalizeCourseName("ielts"), normalizeCourseName("IELTS"));
  assert.equal(normalizeCourseName("GRE"), "gre");
});

// --- renewal arithmetic -----------------------------------------------------

const T = at("2026-12-01", "10:00");
const evalAt = (mocks, bookings) =>
  evaluateEntitlement({ mocks, course: "ielts", mode: "computer-based", testStartMs: T, bookings });
const hist = (date, overrides = {}) =>
  seedBookingShape({ bookingDate: date, testTime: "10:00", ...overrides });
function seedBookingShape(overrides = {}) {
  return {
    name: "IELTS",
    testType: "Computer-Based",
    status: "pending",
    location: "Home",
    ...overrides,
  };
}

test("U-08 4.11 — a fully consumed expired MR does not block a valid renewal", () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: "2026-06-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const renewal = mr({
    mock: 3,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const bookings = [hist("2026-02-01"), hist("2026-03-01"), hist("2026-04-01")];
  const result = evalAt([expired, renewal], bookings);
  assert.equal(result.eligible, true, "a naive lifetime count would wrongly block this");
  assert.equal(result.availableAtTest, 3);
  assert.equal(result.historyAttributed, 3, "all three were attributed to the expired MR");
});

test("U-09 4.12 — an exhausted renewal refuses the next booking", () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: "2026-06-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const renewal = mr({
    mock: 3,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const bookings = [
    hist("2026-02-01"),
    hist("2026-03-01"),
    hist("2026-04-01"),
    hist("2026-12-01"),
    hist("2026-12-02"),
    hist("2026-12-03"),
  ];
  const result = evalAt([expired, renewal], bookings);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "capacity-exhausted");
  assert.equal(result.availableAtTest, 0);
});

test("U-10 4.13 — unused expired capacity is never carried into the renewal", () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: "2026-06-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const renewal = mr({
    mock: 2,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  // Only ONE of the three expired credits was used; two are unreachable.
  const first = evalAt([expired, renewal], [hist("2026-03-01")]);
  assert.equal(first.availableAtTest, 2, "exactly the renewal's two credits are usable");

  const second = evalAt([expired, renewal], [hist("2026-03-01"), hist("2026-12-01")]);
  assert.equal(second.availableAtTest, 1);

  const third = evalAt([expired, renewal], [hist("2026-03-01"), hist("2026-12-01"), hist("2026-12-02")]);
  assert.equal(third.eligible, false, "the third attempt must be refused");
  assert.equal(third.reason, "capacity-exhausted");
});

test("U-11 fail closed: no MR rows / no matching course / no matching mode", () => {
  assert.equal(evalAt([], []).reason, "no-mr-rows");
  assert.equal(evalAt(undefined, []).reason, "no-mr-rows");
  assert.equal(evalAt([mr({ mockType: "GRE" })], []).reason, "no-matching-mr");
  assert.equal(evalAt([mr({ testType: "Paper-Based" })], []).reason, "no-matching-mr");
  // A positive `users.mock` is not part of this evaluator at all: the caller
  // must never be able to convert a balance into course-specific eligibility.
});

test("U-12 fail closed: missing and malformed expiry can never mean unlimited", () => {
  assert.equal(evalAt([mr({ mrValidationExpiry: undefined })], []).reason, "missing-expiry");
  assert.equal(evalAt([mr({ mrValidationExpiry: null })], []).reason, "missing-expiry");
  assert.equal(evalAt([mr({ mrValidationExpiry: "" })], []).reason, "missing-expiry");
  for (const bad of ["not-a-date", "31/12/2027", "2026-13-40", "tomorrow", "0"]) {
    const result = evalAt([mr({ mrValidationExpiry: bad })], []);
    assert.equal(result.eligible, false, `${bad} must not authorise a booking`);
    assert.equal(result.reason, "invalid-expiry");
  }
});

test("U-13 fail closed: an MR expired before the test start rejects", () => {
  const result = evalAt([mr({ mrValidationExpiry: "2026-11-30T00:00:00.000Z" })], []);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "expired-before-test");
});

test("U-14 an MR expiring exactly at the test start is valid", () => {
  const exact = new Date(T).toISOString();
  const result = evalAt([mr({ mock: 1, mrValidationExpiry: exact })], []);
  assert.equal(result.eligible, true, "validity is inclusive at the test instant");
  assert.equal(result.availableAtTest, 1);
});

test("U-15 a date-only expiry is valid through the end of that Dhaka day", () => {
  // Test starts 10:00 Dhaka on 2026-12-01; a date-only expiry of 2026-12-01
  // therefore still covers it, but 2026-11-30 does not.
  assert.equal(evalAt([mr({ mrValidationExpiry: "2026-12-01" })], []).eligible, true);
  assert.equal(evalAt([mr({ mrValidationExpiry: "2026-11-30" })], []).eligible, false);
});

test("U-16 a row with zero purchased quantity cannot authorise a booking", () => {
  const result = evalAt([mr({ mock: 0 })], []);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "capacity-exhausted");
});

test("U-17 usage can never exceed a row's purchased quantity", () => {
  const row = mr({ mock: 2 });
  const bookings = [hist("2026-12-01"), hist("2026-12-02"), hist("2026-12-03")];
  const result = evalAt([row], bookings);
  assert.equal(result.eligible, false);
  assert.equal(result.availableAtTest, 0);
});

test("U-18 cancelled bookings do not consume capacity", () => {
  const row = mr({ mock: 2 });
  const bookings = [
    hist("2026-12-01", { status: "cancelled" }),
    hist("2026-12-02", { status: "Cancelled" }),
    hist("2026-12-03", { status: "pending" }),
  ];
  const result = evalAt([row], bookings);
  assert.equal(result.availableAtTest, 1, "only the active booking consumed a credit");
});

test("U-19 a booking made before the MR was purchased is not attributed to it", () => {
  const row = mr({
    mock: 1,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  // The historical test (2026-02-01) predates the MR purchase, and nothing else
  // can cover it, so it must NOT leave the single credit looking available.
  const result = evalAt([row], [hist("2026-02-01")]);
  assert.equal(result.eligible, false);
  assert.equal(result.historyAttributed, 0);
  assert.equal(result.historyUnattributed, 1);
});

test("U-20 an unknown purchase date is a recorded leniency, not an over-allocation", () => {
  const row = mr({ mock: 1, createdAt: undefined });
  const result = evalAt([row], []);
  assert.equal(result.eligible, true);
  assert.equal(result.uncertainty.unknownPurchaseDates, 1);
});

test("U-21 unattributable history is charged, never silently ignored", () => {
  const row = mr({ mock: 1 });
  // An unparseable test date cannot be attributed to any row. Ignoring it would
  // report one credit as available when it may already have been consumed.
  const result = evalAt([row], [seedBookingShape({ bookingDate: "not-a-date", testTime: "10:00" })]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "capacity-exhausted");
  assert.equal(result.historyUnattributed, 1);
});

test("U-22 equal-expiry rows are consumed deterministically and never over-allocated", () => {
  const expiry = dhakaIsoIn(180);
  const first = mr({ mock: 1, mrValidationExpiry: expiry, createdAt: new Date("2026-01-01T00:00:00.000Z") });
  const second = mr({ mock: 1, mrValidationExpiry: expiry, createdAt: new Date("2026-01-02T00:00:00.000Z") });
  assert.equal(evalAt([first, second], []).availableAtTest, 2);
  assert.equal(evalAt([first, second], [hist("2026-12-01")]).availableAtTest, 1);
  assert.equal(evalAt([first, second], [hist("2026-12-01"), hist("2026-12-02")]).availableAtTest, 0);
});

test("U-23 an expired MR absorbs its own usage instead of the live renewal", () => {
  const expired = mr({
    mock: 2,
    mrValidationExpiry: "2026-06-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const renewal = mr({
    mock: 2,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const result = evalAt([expired, renewal], [hist("2026-02-01"), hist("2026-03-01")]);
  assert.equal(result.availableAtTest, 2, "both renewal credits remain");
  assert.equal(result.historyAttributed, 2);
});

test("U-24 history for another course or mode is irrelevant", () => {
  const row = mr({ mock: 2 });
  const bookings = [
    hist("2026-12-01", { name: "GRE" }),
    hist("2026-12-02", { testType: "Paper-Based" }),
  ];
  const result = evalAt([row], bookings);
  assert.equal(result.availableAtTest, 2);
  assert.equal(result.historyConsidered, 0);
});

test("U-25 usage matching is case-insensitive and PTE-normalised", () => {
  const row = mr({ mockType: "Pearson PTE", testType: "Computer-Based", mock: 1 });
  const result = evaluateEntitlement({
    mocks: [row],
    course: "pearson pte",
    mode: "computer-based",
    testStartMs: T,
    bookings: [
      seedBookingShape({ name: "pte", testType: "computer-based", bookingDate: "2026-12-01" }),
    ],
  });
  assert.equal(result.availableAtTest, 0, "a lower-case stored name still consumes the credit");
});

// ===========================================================================
// GROUP A2 — Day-4 corrective findings D4-R01 / D4-R02 / D4-R03
// ===========================================================================

test("U-26 D4-R01 impossible calendar dates in an ISO instant are rejected", () => {
  // Date.parse() accepts every one of these by rolling the date over
  // (2027-02-30 -> 2027-03-02), so a malformed expiry used to read as a real one.
  const impossible = [
    "2027-02-30T00:00:00Z",
    "2027-02-29T00:00:00Z", // 2027 is not a leap year
    "2027-04-31T00:00:00Z",
    "2027-06-31T00:00:00Z",
    "2027-09-31T00:00:00.000Z",
    "2027-00-10T00:00:00Z", // month 0
    "2027-13-01T00:00:00Z", // month 13
    "2027-01-00T00:00:00Z", // day 0
    "2027-01-01T00:00:00+24:00",
  ];
  // Documented pre-fix behaviour, which is why the parser no longer defers to
  // Date.parse(): V8 accepts these by rolling the calendar over.
  assert.equal(Number.isFinite(Date.parse("2027-02-30T00:00:00Z")), true);
  assert.equal(Number.isFinite(Date.parse("2027-04-31T00:00:00Z")), true);
  assert.equal(Number.isFinite(Date.parse("2027-01-01T24:00:00Z")), true);
  for (const value of impossible) {
    const parsed = parseExpiryInstant(value);
    assert.equal(parsed.ok, false, `${value} must not be a usable expiry`);
    assert.equal(parsed.reason, "invalid");
  }
});

test("U-27 D4-R01 leap-year rules are applied to the calendar, not to rounding", () => {
  assert.equal(parseExplicitInstant("2028-02-29T00:00:00Z").ok, true, "2028 is a leap year");
  assert.equal(parseExplicitInstant("2024-02-29T00:00:00Z").ok, true);
  assert.equal(parseExplicitInstant("2000-02-29T00:00:00Z").ok, true, "400-year rule");
  assert.equal(parseExplicitInstant("2027-02-29T00:00:00Z").ok, false, "2027 is not a leap year");
  assert.equal(parseExplicitInstant("2100-02-29T00:00:00Z").ok, false, "2100 is not a leap year");
  assert.equal(parseExplicitInstant("1900-02-29T00:00:00Z").ok, false);
});

test("U-28 D4-R01 clock and UTC offset are validated component by component", () => {
  for (const bad of [
    "2030-01-01T24:00:00Z", // 24:00:00 is not a wall-clock time
    "2030-01-01T23:60:00Z",
    "2030-01-01T23:59:60Z",
    "2030-01-01T00:00:00+24:00", // no UTC offset reaches 24 hours
    "2030-01-01T00:00:00+99:00",
    "2030-01-01T00:00:00+06:60", // nor 60 minutes
    "2030-01-01T00:00:00-24:00",
  ]) {
    assert.equal(parseExplicitInstant(bad).ok, false, `${bad} must be rejected`);
  }

  // Valid explicit offsets must keep working, in both directions.
  assert.equal(parseExplicitInstant("2030-01-01T00:00:00Z").ms, Date.UTC(2030, 0, 1, 0, 0, 0, 0));
  assert.equal(
    parseExplicitInstant("2030-01-01T00:00:00+06:00").ms,
    Date.UTC(2029, 11, 31, 18, 0, 0, 0),
    "a +06:00 offset is subtracted from the wall clock"
  );
  assert.equal(
    parseExplicitInstant("2030-01-01T00:00:00-05:30").ms,
    Date.UTC(2030, 0, 1, 5, 30, 0, 0),
    "a -05:30 offset is added to the wall clock"
  );
  assert.equal(
    parseExplicitInstant("2030-01-01T00:00:00+0600").ms,
    Date.UTC(2029, 11, 31, 18, 0, 0, 0),
    "the colonless offset form must stay supported"
  );
  assert.equal(
    parseExplicitInstant("2030-01-01T00:00:00.999Z").ms,
    Date.UTC(2030, 0, 1, 0, 0, 0, 999)
  );
});

test("U-29 D4-R01 the strict instant parser is timezone-independent", () => {
  const script = `
    const { parseExplicitInstant } = require(${JSON.stringify(UTIL_PATH)});
    process.stdout.write([
      parseExplicitInstant("2030-06-01T10:00:00Z").ms,
      parseExplicitInstant("2030-06-01T10:00:00+06:00").ms,
      parseExplicitInstant("2030-02-30T10:00:00Z").ok,
    ].join(","));
  `;
  const run = (tz) =>
    execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
  const utc = run("UTC");
  assert.equal(run("Asia/Dhaka"), utc, "the instant must not depend on the server TZ");
  assert.equal(run("America/New_York"), utc);
  assert.equal(utc.split(",")[0], String(Date.UTC(2030, 5, 1, 10, 0, 0, 0)));
  assert.equal(utc.split(",")[1], String(Date.UTC(2030, 5, 1, 4, 0, 0, 0)));
  assert.equal(utc.split(",")[2], "false", "an impossible date is rejected in every timezone");
});

test("U-30 D4-R01 a corrupt date never becomes valid entitlement", () => {
  // An impossible expiry cannot authorise the booking, even though a lenient
  // parse would have produced a future instant.
  const badExpiry = evalAt([mr({ mock: 1, mrValidationExpiry: "2027-02-30T00:00:00Z" })], []);
  assert.equal(badExpiry.eligible, false);
  assert.equal(badExpiry.reason, "invalid-expiry");

  // An impossible purchase date is corruption, not "unknown": the row may not be
  // relied on for historical attribution.
  const badPurchase = evalAt(
    [mr({ mock: 1, createdAt: "2027-02-30T00:00:00Z" })],
    []
  );
  assert.equal(badPurchase.eligible, false);
  assert.equal(badPurchase.reason, "invalid-purchase");
  assert.equal(badPurchase.uncertainty.invalidPurchaseRows, 1);

  // An ABSENT purchase date keeps the documented legacy leniency (U-20).
  const absentPurchase = evalAt([mr({ mock: 1, createdAt: undefined })], []);
  assert.equal(absentPurchase.eligible, true);
  assert.equal(absentPurchase.uncertainty.unknownPurchaseDates, 1);
  assert.equal(absentPurchase.uncertainty.invalidPurchaseRows, 0);

  // The date-only form keeps its Dhaka end-of-day semantics.
  assert.equal(parseExpiryInstant("2026-12-01").ms, Date.UTC(2026, 11, 1, 23, 59, 59, 999) - DHAKA_OFFSET_MS);
});

test("U-31 D4-R02 MR quantities must be non-negative whole numbers", () => {
  const accepted = [
    [2, 2],
    [0, 0],
    ["2", 2],
    [" 10 ", 10],
    ["0", 0],
    [2.0, 2], // BSON doubles holding a whole value
  ];
  for (const [input, expected] of accepted) {
    const parsed = parseMockQuantity(input);
    assert.equal(parsed.ok, true, `${JSON.stringify(input)} must be accepted`);
    assert.equal(parsed.value, expected);
  }

  const rejected = [0.5, 1.5, -1, -0.5, "1.5", "-1", "", " ", "abc", "2e3", "1,5", true, false, null, undefined, NaN, Infinity, {}, [], Number.MAX_SAFE_INTEGER + 2];
  for (const input of rejected) {
    assert.equal(parseMockQuantity(input).ok, false, `${JSON.stringify(input)} must be rejected`);
  }
});

test("U-32 D4-R02 a malformed quantity contributes no capacity and is not rounded", () => {
  // 0.5 used to authorise a whole booking, and 1.5 used to authorise two.
  for (const quantity of [0.5, 1.5, "1.5", -1, true, "abc"]) {
    const result = evalAt([mr({ mock: quantity })], []);
    assert.equal(result.eligible, false, `quantity ${JSON.stringify(quantity)} must not authorise a booking`);
    assert.equal(result.availableAtTest, 0);
    assert.equal(result.reason, "invalid-quantity");
    assert.equal(result.uncertainty.invalidQuantityRows, 1);
  }

  // Zero is valid-but-empty, so it stays distinguishable from malformed data.
  assert.equal(evalAt([mr({ mock: 0 })], []).reason, "capacity-exhausted");

  // A malformed row must never poison a valid sibling for the same course/mode.
  const mixed = evalAt([mr({ mock: 0.5 }), mr({ mock: 2 })], []);
  assert.equal(mixed.eligible, true);
  assert.equal(mixed.availableAtTest, 2, "only the whole-number row supplies capacity");

  // Nor may an unrelated course's malformed row affect this request.
  const unrelated = evalAt([mr({ mockType: "GRE", mock: 1.5 }), mr({ mock: 1 })], []);
  assert.equal(unrelated.eligible, true);
  assert.equal(unrelated.availableAtTest, 1);
});

test("U-33 D4-R02 renewal arithmetic still uses whole credits", () => {
  const expired = mr({
    mock: "2", // legacy numeric-string row, consumed before renewal
    mrValidationExpiry: "2026-06-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const renewal = mr({
    mock: 2,
    mrValidationExpiry: "2027-06-01T00:00:00.000Z",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const two = evalAt([expired, renewal], [hist("2026-02-01"), hist("2026-03-01")]);
  assert.equal(two.availableAtTest, 2, "4.11/4.13: expired usage does not consume the renewal");
  const twoUsed = evalAt([expired, renewal], [
    hist("2026-02-01"),
    hist("2026-03-01"),
    hist("2026-12-01"),
    hist("2026-12-02"),
  ]);
  assert.equal(twoUsed.availableAtTest, 0, "4.12: the exhausted renewal refuses the next booking");
  assert.ok(Number.isInteger(twoUsed.availableAtTest), "capacity stays an integer");
});

test("U-34 D4-R03 an empty mode is never a verified match", () => {
  // A request with no mode is refused by the evaluator itself, whatever the rows
  // look like — this is defence in depth behind the route's 400.
  for (const mode of ["", "   ", null, undefined]) {
    const result = evaluateEntitlement({
      mocks: [mr({ testType: undefined })],
      course: "ielts",
      mode,
      testStartMs: T,
      bookings: [],
    });
    assert.equal(result.eligible, false, `mode ${JSON.stringify(mode)} must not authorise a booking`);
    assert.equal(result.reason, "missing-mode");
  }

  // Two empty strings are not a course-and-mode match even if the caller passes
  // one through: the row has no test type, so nothing can match it.
  const rowWithoutMode = evalAt([mr({ testType: undefined })], []);
  assert.equal(rowWithoutMode.eligible, false);
  assert.equal(rowWithoutMode.reason, "no-matching-mr");

  // A row with no course is likewise not evidence of anything.
  const rowWithoutCourse = evalAt([mr({ mockType: undefined })], []);
  assert.equal(rowWithoutCourse.eligible, false);
  assert.equal(rowWithoutCourse.reason, "no-matching-mr");
});

test("U-35 D4-R03 valid modes keep exact normalisation (no invented wildcard)", () => {
  assert.equal(normalizeMode("Computer-Based"), "computer-based");
  assert.equal(normalizeMode("  computer-based "), "computer-based");
  assert.equal(normalizeMode("PAPER-BASED"), "paper-based");
  assert.notEqual(normalizeMode("Computer-Based"), normalizeMode("Paper-Based"));

  // A valid, differently-cased mode still matches and consumes the credit.
  const row = mr({ mock: 1, testType: "computer-based" });
  const result = evalAt([row], []);
  assert.equal(result.eligible, true, "case differences must not block a valid mode");
  assert.equal(result.availableAtTest, 1);

  // Paper-Based is a separate entitlement, not a wildcard match.
  const paperOnly = evalAt([mr({ testType: "Paper-Based", mock: 1 })], []);
  assert.equal(paperOnly.reason, "no-matching-mr");
});

// ===========================================================================
// GROUP A2 — D4-R04 requested-test purchase boundary
// ===========================================================================

test("U-36 D4-R04 an MR purchased before the requested test supplies its credits", () => {
  const row = mr({
    mock: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.eligible, true);
  assert.equal(result.reason, "ok");
  assert.equal(result.availableAtTest, 2, "both credits were bought before the test");
  assert.equal(result.rowsLive, 1);
  assert.equal(result.uncertainty.notYetPurchasedRows, 0);
});

test("U-37 D4-R04 a purchase exactly at the test start is eligible (inclusive boundary)", () => {
  const row = mr({
    mock: 1,
    createdAt: new Date(T),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.eligible, true, "purchase <= testStart must be accepted");
  assert.equal(result.availableAtTest, 1);
  assert.equal(result.uncertainty.notYetPurchasedRows, 0);
});

test("U-38 D4-R04 a purchase one millisecond after the test start is not eligible", () => {
  const row = mr({
    mock: 1,
    createdAt: new Date(T + 1),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.eligible, false, "the MR did not exist at the test instant");
  assert.equal(result.availableAtTest, 0);
  assert.equal(result.reason, "not-yet-purchased");
  assert.equal(result.uncertainty.notYetPurchasedRows, 1);
});

test("U-39 D4-R04 an MR purchased a year after the test is not eligible", () => {
  const row = mr({
    mock: 3,
    createdAt: new Date(T + 365 * 24 * HOUR_MS),
    mrValidationExpiry: "2030-01-01T00:00:00Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.eligible, false);
  assert.equal(result.availableAtTest, 0);
  assert.equal(result.reason, "not-yet-purchased");
});

test("U-40 D4-R04 a valid expiry alone is not usable capacity (future purchase)", () => {
  const row = mr({
    mock: 2,
    createdAt: new Date("2028-01-01T00:00:00Z"),
    mrValidationExpiry: "2029-12-31T23:59:59Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.availableAtTest, 0, "a row bought after the test has no usable capacity");
  assert.equal(result.rowsLive, 0);
  assert.equal(result.eligible, false);
  // The row is in date; it must never be reported as expired.
  assert.notEqual(result.reason, "expired-before-test");
  assert.equal(result.reason, "not-yet-purchased");
});

test("U-41 D4-R04 an MR that expired before the test is refused as expired", () => {
  const row = mr({
    mock: 2,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    mrValidationExpiry: "2026-06-01T00:00:00Z",
  });

  const result = evalAt([row], []);

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "expired-before-test", "expiry stays a distinct reason");
  assert.equal(result.availableAtTest, 0);
});

test("U-42 D4-R04 only the already-purchased row of a mixed set contributes", () => {
  const valid = mr({
    mock: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });
  const future = mr({
    mock: 5,
    createdAt: new Date("2028-01-01T00:00:00Z"),
    mrValidationExpiry: "2030-01-01T00:00:00Z",
  });

  const result = evalAt([future, valid], []);

  assert.equal(result.eligible, true);
  assert.equal(result.availableAtTest, 1, "the future row's five credits are not spendable");
  assert.equal(result.rowsMatched, 2, "both rows match course and mode");
  assert.equal(result.uncertainty.notYetPurchasedRows, 1);
});

test("U-43 D4-R04 an absent purchase timestamp keeps the documented legacy leniency", () => {
  const legacy = mr({
    mock: 2,
    createdAt: undefined,
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([legacy], []);

  assert.equal(result.eligible, true, "no purchase date is the documented legacy gap, not a refusal");
  assert.equal(result.availableAtTest, 2);
  assert.equal(result.uncertainty.unknownPurchaseDates, 1);
  assert.equal(result.uncertainty.notYetPurchasedRows, 0);
});

test("U-44 D4-R04 a corrupt purchase timestamp is fail-closed, never a usable credit", () => {
  const corrupt = mr({
    mock: 3,
    createdAt: "2027-02-30T00:00:00Z",
    mrValidationExpiry: "2029-12-31T23:59:59Z",
  });

  const result = evalAt([corrupt], []);

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "invalid-purchase");
  assert.equal(result.availableAtTest, 0, "an unverifiable purchase date supplies no capacity");
  assert.equal(result.uncertainty.invalidPurchaseRows, 1);
});

test("U-45 D4-R04 history after a future MR's purchase stays attributable to it", () => {
  // `later` is purchased after the REQUESTED test, so it supplies no capacity for
  // it — but the historical booking (2027-08-01) happened after `later` was
  // bought, so it must be attributed there rather than pushed onto `early`.
  const early = mr({
    mock: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });
  const later = mr({
    mock: 1,
    createdAt: new Date("2027-01-01T00:00:00Z"),
    mrValidationExpiry: "2030-01-01T00:00:00Z",
  });

  const result = evalAt([early, later], [hist("2027-08-01")]);

  assert.equal(result.historyConsidered, 1);
  assert.equal(result.historyAttributed, 1, "the booking is covered by `later`");
  assert.equal(result.historyUnattributed, 0);
  assert.equal(result.availableAtTest, 1, "`early` still supplies the requested-test credit");
});

test("U-46 D4-R04 history before the MR purchase is not attributed, only charged", () => {
  const row = mr({
    mock: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([row], [hist("2025-06-01")]);

  assert.equal(result.historyAttributed, 0, "the booking predates the purchase");
  assert.equal(result.historyUnattributed, 1);
  assert.equal(result.availableAtTest, 1, "the charge is applied conservatively, never ignored");
});

test("U-47 D4-R04 renewal 4.11 stays correct when rows carry purchase dates", () => {
  const expired = mr({
    mock: 2,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    mrValidationExpiry: "2026-06-01T00:00:00Z",
  });
  const renewal = mr({
    mock: 2,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });

  const result = evalAt([expired, renewal], [hist("2026-03-01")]);

  assert.equal(result.historyAttributed, 1, "the March booking is covered by the then-valid row");
  assert.equal(result.availableAtTest, 2, "4.11: expired usage does not consume the renewal");
});

test("U-48 D4-R04 purchase timestamps with explicit UTC offsets are exact", () => {
  const expiry = "2027-06-01T00:00:00Z";
  // 10:00 +06:00 is exactly T (04:00Z).
  const exact = mr({ mock: 1, createdAt: "2026-12-01T10:00:00+06:00", mrValidationExpiry: expiry });
  assert.equal(evalAt([exact], []).availableAtTest, 1, "an offset form equal to T is accepted");

  // 10:00:00.001 +06:00 is one millisecond past T.
  const late = mr({ mock: 1, createdAt: "2026-12-01T10:00:00.001+06:00", mrValidationExpiry: expiry });
  assert.equal(evalAt([late], []).eligible, false, "one millisecond past T is not purchased yet");

  // 23:00 -05:00 on 30 November is also exactly T.
  const negative = mr({ mock: 1, createdAt: "2026-11-30T23:00:00-05:00", mrValidationExpiry: expiry });
  assert.equal(evalAt([negative], []).availableAtTest, 1, "negative offsets resolve to the same instant");
});

test("U-49 D4-R04 date-only purchase values keep their Dhaka interpretation", () => {
  const expiry = "2027-06-01T00:00:00Z";
  const sameDay = mr({ mock: 1, createdAt: "2026-12-01", mrValidationExpiry: expiry });
  assert.equal(
    evalAt([sameDay], []).availableAtTest,
    1,
    "a date-only value means the start of that day in Dhaka, before the 10:00 test"
  );

  const nextDay = mr({ mock: 1, createdAt: "2026-12-02", mrValidationExpiry: expiry });
  assert.equal(
    evalAt([nextDay], []).eligible,
    false,
    "the next day starts after the test, so it is not purchased yet"
  );
});

test("U-50 D4-R04 unattributable history never charges a future-purchased row", () => {
  // `shortLived` has the earliest expiry, so an expiry-only charge would land on
  // it and leave `main`'s credit intact — inventing capacity for the requested
  // test. The charge must go to the row that is usable at the requested test.
  const shortLived = mr({
    mock: 1,
    createdAt: new Date("2027-01-05T00:00:00Z"),
    mrValidationExpiry: "2027-01-31T00:00:00Z",
  });
  const main = mr({
    mock: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
  });
  const undated = hist("2026-03-01", { testTime: "" });

  const result = evalAt([shortLived, main], [undated]);

  assert.equal(result.uncertainty.unattributableHistory, 1);
  assert.equal(result.uncertainty.unresolvedCharges, 0, "the charge found a usable row");
  assert.equal(
    result.availableAtTest,
    0,
    "the charge consumes the requested-test pool, not the future row"
  );
});

// ===========================================================================
// GROUP B — HTTP integration
// ===========================================================================

test("H-01 4.1 a Test Center session 23 hours away is refused", async () => {
  const student = await bookableStudent();
  const near = dhakaAtHours(23);
  const schedule = await seedSchedule({
    startDate: near.date,
    endDate: near.date,
    timeSlots: [{ slotId: "1", startTime: `${near.time}:00`, endTime: "23:59:00", slot: 5, totalSlot: 5 }],
  });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /24 hours/);
  assert.equal(await mockOf(student), 5, "no credit may be consumed");
  assert.deepEqual(await slotMap(schedule._id), { "1": 5 }, "no seat may be consumed");
  assert.equal(await bookingCount(student._id), 0);
});

test("H-02 4.2 a verified admin may book inside 24 hours for a future test", async () => {
  const admin = await seedUser({ role: "admin", name: "Synthetic Admin" });
  const student = await bookableStudent();
  const near = dhakaAtHours(6);
  const schedule = await seedSchedule({
    startDate: near.date,
    endDate: near.date,
    timeSlots: [{ slotId: "1", startTime: `${near.time}:00`, endTime: "23:59:00", slot: 5, totalSlot: 5 }],
  });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(admin),
    body: centerBody(student, schedule),
  });

  assert.equal(res.status, 200, `admin booking must succeed (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 4);
});

test("H-03 4.2b the admin exception never allows a past test", async () => {
  const admin = await seedUser({ role: "admin", name: "Synthetic Admin" });
  const student = await bookableStudent();
  const past = dhakaAtHours(-30);

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(admin),
    body: homeBody(student, { bookingDate: past.date, testTime: past.time }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /already passed/);
  assert.equal(await mockOf(student), 5);
});

test("H-04 4.2c the admin exception does not exempt an unapproved student", async () => {
  const admin = await seedUser({ role: "admin", name: "Synthetic Admin" });
  const student = await bookableStudent({ status: "active" });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(admin),
    body: homeBody(student),
  });

  assert.equal(res.status, 403);
  assert.equal(await mockOf(student), 5);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-05 4.4 a non-completed account is refused with 403", async () => {
  for (const status of ["active", "pending", null, ""]) {
    const student = await bookableStudent({ status });
    const res = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: homeBody(student),
    });
    assert.equal(res.status, 403, `status ${JSON.stringify(status)} must be refused`);
    assert.equal(await mockOf(student), 5, "no credit may be consumed");
    assert.equal(await bookingCount(student._id), 0);
  }

  // A missing status field is refused too (fail closed).
  const absent = await bookableStudent();
  await usersCollection.updateOne({ _id: absent._id }, { $unset: { status: "" } });
  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(absent),
    body: homeBody(absent),
  });
  assert.equal(res.status, 403, "an account with no status must not book");
  assert.equal(await mockOf(absent), 5);
});

test("H-06 a positive balance with no MR rows cannot authorise a booking", async () => {
  const student = await seedUser({ mock: 5, totalMock: 5 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 5);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-07 4.3 an expired MR is refused and changes nothing", async () => {
  const expired = mr({ mock: 3, mrValidationExpiry: dhakaIsoIn(-30) });
  const student = await studentWith([expired], { mock: 3, totalMock: 3 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 3);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-08 an MR with a missing or malformed expiry is refused (fail closed)", async () => {
  for (const expiry of [undefined, null, "not-a-date", "31/12/2027"]) {
    const row = mr({ mock: 2, mrValidationExpiry: expiry });
    const student = await studentWith([row], { mock: 2, totalMock: 2 });

    const res = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: homeBody(student),
    });

    assert.equal(res.status, 400, `expiry ${JSON.stringify(expiry)} must not authorise a booking`);
    assert.equal(await mockOf(student), 2);
    assert.equal(await bookingCount(student._id), 0);
  }
});

test("H-09 4.5 an IELTS schedule cannot be booked as PTE", async () => {
  const student = await bookableStudent();
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1", { name: "Pearson PTE" }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /course for this schedule could not be verified/);
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 });
  assert.equal(await mockOf(student), 5);
});

test("H-10 4.6 a case variation cannot bypass exhausted credits", async () => {
  const row = mr({ mock: 1 });
  const student = await studentWith([row], { mock: 1, totalMock: 1 });
  await seedBooking({ userId: String(student._id), name: "IELTS", testType: "Computer-Based", bookingDate: "2026-02-01" });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { name: "ielts", testType: "COMPUTER-BASED" }),
  });

  assert.equal(res.status, 400, "lower-case course/mode must not reset the used count");
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 1);
});

test("H-11 4.7 IELTS credits cannot be spent on GRE", async () => {
  const student = await bookableStudent();
  const schedule = await seedSchedule({ courseId: String(greCourse._id), name: "GRE" });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1", { name: "GRE" }),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 });
});

test("H-12 4.8 a Home booking 20 hours away is refused", async () => {
  const student = await bookableStudent();
  const near = dhakaAtHours(20);

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: near.date, testTime: near.time }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /24 hours/);
  assert.equal(await mockOf(student), 5);
});

test("H-13 4.9 a valid Test Center booking stores the canonical course and type", async () => {
  const student = await bookableStudent();
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    // A stale client sends its own (wrong) mode; the schedule is authoritative.
    body: centerBody(student, schedule, "2", { testType: "Academic" }),
  });

  assert.equal(res.status, 200, `booking must succeed (got ${JSON.stringify(res.body)})`);
  assert.equal(res.body.bookingRecord.name, "IELTS");
  assert.equal(res.body.bookingRecord.testType, "Computer-Based");
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 2 }, "the chosen slot loses one seat");
  assert.equal(await mockOf(student), 4);

  const stored = await bookingMockCollection.findOne({ userId: String(student._id) });
  assert.equal(stored.name, "IELTS", "the stored course is canonical");
  assert.equal(stored.testType, "Computer-Based");
  assert.equal(stored.bookingDate, schedule.startDate);
});

test("H-14 4.10 invalid dates and times are refused", async () => {
  const student = await bookableStudent();
  for (const body of [
    { bookingDate: "2026-13-40", testTime: "10:00" },
    { bookingDate: "2026-02-30", testTime: "10:00" },
    { bookingDate: dhakaDateIn(7), testTime: "24:00" },
    { bookingDate: dhakaDateIn(7), testTime: "12:60" },
    { bookingDate: "07/12/2026", testTime: "10:00" },
  ]) {
    const res = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: homeBody(student, body),
    });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused`);
    assert.match(res.body.message, /invalid/);
  }
  assert.equal(await mockOf(student), 5);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-15 4.11 a valid renewal succeeds despite fully consumed expired credits", async () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: dhakaIsoIn(-120),
    createdAt: new Date(Date.now() - 400 * 24 * HOUR_MS),
  });
  const renewal = mr({ mock: 3, mrValidationExpiry: dhakaIsoIn(180) });
  const student = await studentWith([expired, renewal], { mock: 3, totalMock: 6 });
  for (const date of ["2026-02-01", "2026-03-01", "2026-04-01"]) {
    await seedBooking({ userId: String(student._id), bookingDate: date });
  }

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 200, `renewal must be usable (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 2);
});

test("H-16 4.12 a fully consumed renewal is refused", async () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: dhakaIsoIn(-120),
    createdAt: new Date(Date.now() - 400 * 24 * HOUR_MS),
  });
  const renewal = mr({ mock: 3, mrValidationExpiry: dhakaIsoIn(180) });
  // `mock` is deliberately left at 3 so the refusal must come from the
  // entitlement reconstruction, not from the balance pre-check.
  const student = await studentWith([expired, renewal], { mock: 3, totalMock: 6 });
  const dates = ["2026-02-01", "2026-03-01", "2026-04-01", dhakaDateIn(2), dhakaDateIn(3), dhakaDateIn(4)];
  for (const date of dates) {
    await seedBooking({ userId: String(student._id), bookingDate: date });
  }

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 3, "no credit may be consumed");
});

test("H-17 4.13 two bookings succeed on the renewal, the third is refused", async () => {
  const expired = mr({
    mock: 3,
    mrValidationExpiry: dhakaIsoIn(-120),
    createdAt: new Date(Date.now() - 400 * 24 * HOUR_MS),
  });
  const renewal = mr({ mock: 2, mrValidationExpiry: dhakaIsoIn(180) });
  const student = await studentWith([expired, renewal], { mock: 4, totalMock: 5 });
  await seedBooking({ userId: String(student._id), bookingDate: "2026-03-01" });

  const attempts = [dhakaDateIn(7), dhakaDateIn(8), dhakaDateIn(9)];
  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: attempts[0] }),
  });
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: attempts[1] }),
  });
  const third = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: attempts[2] }),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 400, "the expired MR's two unused credits must not carry over");
  assert.equal(third.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 2);
  assert.equal(await bookingCount(student._id), 3, "1 historical + 2 new");
});

test("H-18 4.14 a test just over 24 hours away is accepted", async () => {
  const student = await bookableStudent();
  const soon = dhakaAtHours(25);

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: soon.date, testTime: soon.time }),
  });

  assert.equal(res.status, 200, `just-over-24h must pass (got ${JSON.stringify(res.body)})`);
});

test("H-19 4.15 a Home booking in the past is refused", async () => {
  const student = await bookableStudent();
  const past = dhakaAtHours(-5);

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: past.date, testTime: past.time }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /already passed/);
});

test("H-20 4.17 a cancelled schedule cannot be booked", async () => {
  const student = await bookableStudent();
  const schedule = await seedSchedule({ status: "Cancelled" });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /no longer available/);
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 });
  assert.equal(await mockOf(student), 5);
});

test("H-21 4.18 an unknown Home course is refused", async () => {
  const student = await bookableStudent();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { name: "Unknown Course" }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /could not be verified/);
  assert.equal(await mockOf(student), 5);
});

test("H-22 a Test Center schedule whose course document is missing is refused", async () => {
  const student = await bookableStudent();
  const schedule = await seedSchedule({ courseId: new ObjectId().toHexString() });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /could not be verified/);
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 }, "no seat may be consumed");
  assert.equal(await mockOf(student), 5);
});

test("H-23 PTE and Pearson PTE are interchangeable in both directions", async () => {
  const row = mr({ mockType: "PTE", mock: 2 });
  const student = await studentWith([row], { mock: 2, totalMock: 2 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { name: "Pearson PTE" }),
  });
  assert.equal(res.status, 200, `PTE row must satisfy a Pearson PTE booking (got ${JSON.stringify(res.body)})`);

  const reverseRow = mr({ mockType: "Pearson PTE", mock: 2 });
  const reverse = await studentWith([reverseRow], { mock: 2, totalMock: 2 });
  const reverseRes = await api("POST", "/user/book-slot", {
    token: tokenFor(reverse),
    body: homeBody(reverse, { name: "PTE" }),
  });
  assert.equal(reverseRes.status, 200, `Pearson PTE row must satisfy a PTE booking (got ${JSON.stringify(reverseRes.body)})`);
});

test("H-24 a duplicate Home booking for the same date is refused", async () => {
  const student = await bookableStudent();
  const body = homeBody(student);
  assert.equal((await api("POST", "/user/book-slot", { token: tokenFor(student), body })).status, 200);
  const second = await api("POST", "/user/book-slot", { token: tokenFor(student), body });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /already have a test booked/);
  assert.equal(await bookingCount(student._id), 1);
});

test("H-25 a rejected booking never sends a confirmation email", async () => {
  const student = await bookableStudent({ status: "active" });
  const before = emailInvocations;
  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });
  assert.equal(res.status, 403);
  assert.equal(emailInvocations, before, "no email may be attempted for a rejected booking");
});

test("H-26 concurrent bookings for the final credit cannot both succeed", async () => {
  const row = mr({ mock: 1 });
  const student = await studentWith([row], { mock: 1, totalMock: 1 });
  // Two DIFFERENT schedules, so nothing serialises on the seat: the credit is
  // the only shared resource.
  const first = await seedSchedule();
  const second = await seedSchedule();

  const [a, b] = await Promise.all([
    api("POST", "/user/book-slot", { token: tokenFor(student), body: centerBody(student, first, "1") }),
    api("POST", "/user/book-slot", { token: tokenFor(student), body: centerBody(student, second, "1") }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status !== 200);
  assert.equal(won.length, 1, `exactly one booking may claim the last credit (got ${a.status}/${b.status})`);
  assert.equal(lost.length, 1);
  assert.ok([400, 409].includes(lost[0].status), `loser must be a refusal (got ${lost[0].status})`);
  assert.equal(await mockOf(student), 0, "the balance never goes negative");
  assert.equal(await bookingCount(student._id), 1, "exactly one booking exists");
});

test("H-27 concurrent bookings for the final seat never oversell it", async () => {
  const schedule = await seedSchedule({
    timeSlots: [
      { slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 1, totalSlot: 1 },
    ],
  });
  const first = await bookableStudent();
  const second = await bookableStudent();

  const [a, b] = await Promise.all([
    api("POST", "/user/book-slot", { token: tokenFor(first), body: centerBody(first, schedule, "1") }),
    api("POST", "/user/book-slot", { token: tokenFor(second), body: centerBody(second, schedule, "1") }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  assert.equal(won.length, 1, `exactly one student may take the last seat (got ${a.status}/${b.status})`);
  assert.deepEqual(await slotMap(schedule._id), { "1": 0 }, "the seat never goes negative");
  assert.equal(
    await bookingMockCollection.countDocuments({ scheduleId: String(schedule._id) }),
    1,
    "exactly one booking for the single seat"
  );
});

test("H-28 concurrent identical Home bookings create exactly one booking", async () => {
  const student = await bookableStudent();
  const body = homeBody(student);

  const [a, b] = await Promise.all([
    api("POST", "/user/book-slot", { token: tokenFor(student), body }),
    api("POST", "/user/book-slot", { token: tokenFor(student), body }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  assert.equal(won.length, 1, `exactly one must win (got ${a.status}/${b.status})`);
  assert.equal(await bookingCount(student._id), 1, "no duplicate booking document");
  assert.equal(await mockOf(student), 4, "exactly one credit was consumed");
});

test("H-29 a rejected request changes no credit, seat or booking", async () => {
  const student = await bookableStudent({ status: "active" });
  const schedule = await seedSchedule();
  const before = {
    mock: await mockOf(student),
    slots: await slotMap(schedule._id),
    bookings: await bookingCount(student._id),
    status: await statusOf(student),
  };

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule),
  });

  assert.equal(res.status, 403);
  assert.equal(await mockOf(student), before.mock);
  assert.deepEqual(await slotMap(schedule._id), before.slots);
  assert.equal(await bookingCount(student._id), before.bookings);
  assert.equal(await statusOf(student), before.status);
});

test("H-30 a cancelled booking frees the credit and the date for a new booking", async () => {
  const row = mr({ mock: 1 });
  const student = await studentWith([row], { mock: 1, totalMock: 1 });
  const date = dhakaDateIn(7);
  const cancelled = await seedBooking({
    userId: String(student._id),
    bookingDate: date,
    status: "cancelled",
    cancelledAt: new Date(),
  });
  assert.ok(cancelled._id);

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: date }),
  });

  assert.equal(res.status, 200, `a cancelled booking must not burn the entitlement (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 0);
});

// ===========================================================================
// GROUP C — Day-4 corrective findings D4-R01 / D4-R02 / D4-R03 (HTTP)
// ===========================================================================

test("H-31 D4-R01 an MR with an impossible expiry date is refused", async () => {
  for (const expiry of [
    "2027-02-30T00:00:00Z",
    "2027-04-31T00:00:00Z",
    "2029-01-01T00:00:00+24:00",
  ]) {
    const student = await studentWith([mr({ mock: 2, mrValidationExpiry: expiry })], {
      mock: 2,
      totalMock: 2,
    });

    const res = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: homeBody(student),
    });

    assert.equal(res.status, 400, `expiry ${expiry} must not authorise a booking`);
    assert.equal(res.body.message, "Insufficient mock tests available.");
    assert.equal(await mockOf(student), 2, "no credit was consumed");
    assert.equal(await bookingCount(student._id), 0, "no booking was written");
  }
});

test("H-32 D4-R01 a real leap-day expiry is still accepted", async () => {
  const student = await studentWith([mr({ mock: 1, mrValidationExpiry: "2028-02-29T23:59:59.000Z" })], {
    mock: 1,
    totalMock: 1,
  });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 200, `a valid leap day must book (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 0);
  assert.equal(await bookingCount(student._id), 1);
});

test("H-33 D4-R02 a fractional MR quantity cannot authorise a booking", async () => {
  // The balance is a legitimate whole credit, so the MR row is what must refuse.
  const student = await studentWith([mr({ mock: 0.5 })], { mock: 1, totalMock: 1 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 1);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-34 D4-R02 a 1.5 MR quantity no longer authorises two bookings", async () => {
  const student = await studentWith([mr({ mock: 1.5 })], { mock: 2, totalMock: 2 });

  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(8) }),
  });
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(9) }),
  });

  assert.equal(first.status, 400, "a fraction of a credit is not one credit");
  assert.equal(second.status, 400);
  assert.equal(await bookingCount(student._id), 0);
  assert.equal(await mockOf(student), 2);
});

test("H-35 D4-R02 a digit-only quantity string still supplies whole credits", async () => {
  const student = await studentWith([mr({ mock: "2" })], { mock: 2, totalMock: 2 });

  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(8) }),
  });
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(9) }),
  });
  const third = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(10) }),
  });

  assert.equal(first.status, 200, `legacy "2" must still be usable (got ${JSON.stringify(first.body)})`);
  assert.equal(second.status, 200);
  assert.equal(third.status, 400, "exactly two whole credits were available");
  assert.equal(await mockOf(student), 0);
  assert.equal(await bookingCount(student._id), 2);
});

test("H-36 D4-R02 a fractional student balance cannot be spent or decremented", async () => {
  const student = await studentWith([mr({ mock: 1 })], { mock: 0.5, totalMock: 0.5 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 0.5, "the fraction is neither spent nor repaired");
  assert.equal(await bookingCount(student._id), 0);
});

test("H-37 D4-R02 a single credit is spent exactly once and never goes negative", async () => {
  const student = await studentWith([mr({ mock: 1 })], { mock: 1, totalMock: 1 });

  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(8) }),
  });
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(9) }),
  });

  assert.equal(first.status, 200);
  assert.equal(await mockOf(student), 0);
  assert.equal(second.status, 400);
  assert.equal(await mockOf(student), 0, "the balance never becomes negative");
  assert.equal(await bookingCount(student._id), 1);
});

test("H-38 D4-R02 two credits are spent as two whole credits, never a fraction", async () => {
  const student = await studentWith([mr({ mock: 2 })], { mock: 2, totalMock: 2 });

  const first = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(8) }),
  });
  const second = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(9) }),
  });
  const third = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { bookingDate: dhakaDateIn(10) }),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 400);
  const balance = await mockOf(student);
  assert.equal(balance, 0);
  assert.ok(Number.isInteger(balance), "the balance is always a whole number");
  assert.equal(await bookingCount(student._id), 2);
});

test("H-39 D4-R03 a Home booking without a test type is refused (400, no state change)", async () => {
  for (const testType of [undefined, null, "", "   "]) {
    const student = await bookableStudent();
    const schedule = await seedSchedule();

    const res = await api("POST", "/user/book-slot", {
      token: tokenFor(student),
      body: homeBody(student, { testType }),
    });

    assert.equal(res.status, 400, `testType ${JSON.stringify(testType)} must be refused`);
    // The controlled message proves the ROUTE refuses, not merely the evaluator:
    // this student's MR row has a real mode, so entitlement would also refuse
    // here and a status-only assertion could not tell the two apart.
    assert.equal(res.body.message, "Please select a valid test type for this Home test.");
    assert.equal(await mockOf(student), 5, "no credit was consumed");
    assert.equal(await bookingCount(student._id), 0, "no booking was written");
    assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 });
  }
});

test("H-44 D4-R03 two empty modes never match (the original vulnerability)", async () => {
  // This is the defect itself: the request carried no testType AND the MR row
  // carried no testType, so both normalised to "" and the row authorised a real
  // booking. The row is otherwise perfectly valid, so only the mode guard can
  // refuse it.
  const student = await studentWith([mr({ testType: undefined, mock: 3 })], {
    mock: 3,
    totalMock: 3,
  });
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { testType: undefined }),
  });

  assert.equal(res.status, 400, "an absent test type is not a verified mode");
  assert.equal(res.body.message, "Please select a valid test type for this Home test.");
  assert.equal(await mockOf(student), 3, "no credit was consumed");
  assert.equal(await bookingCount(student._id), 0, "no booking was written");
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 }, "no seat was taken");
});

test("H-40 D4-R03 an MR row without a test type cannot match a real Home mode", async () => {
  const student = await studentWith([mr({ testType: undefined, mock: 3 })], { mock: 3, totalMock: 3 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    // A perfectly valid mode on the request must NOT be satisfied by a row whose
    // own test type is missing.
    body: homeBody(student, { testType: "Computer-Based" }),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
  assert.equal(await mockOf(student), 3);
  assert.equal(await bookingCount(student._id), 0);
});

test("H-41 D4-R03 Test Center mode stays schedule-authoritative", async () => {
  // The schedule is the authority: with an empty schedule.testType the request
  // value is used, and a valid booking still succeeds.
  const student = await bookableStudent();
  const schedule = await seedSchedule({ testType: "" });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1", { testType: "Computer-Based" }),
  });

  assert.equal(res.status, 200, `request mode is the fallback (got ${JSON.stringify(res.body)})`);
  const stored = await bookingMockCollection.findOne({ userId: String(student._id) });
  assert.equal(stored.testType, "Computer-Based");
  assert.equal(stored.name, "IELTS");

  // With neither side establishing a mode, the booking must fail safely.
  const second = await bookableStudent();
  const modeLess = await seedSchedule({
    testType: "",
    timeSlots: [{ slotId: "1", startTime: "09:00:00", endTime: "12:00:00", slot: 4, totalSlot: 4 }],
  });

  const refused = await api("POST", "/user/book-slot", {
    token: tokenFor(second),
    body: centerBody(second, modeLess, "1", { testType: "   " }),
  });

  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /test type for this schedule could not be verified/);
  assert.deepEqual(await slotMap(modeLess._id), { "1": 4 }, "no seat was taken");
  assert.equal(await mockOf(second), 5, "no credit was consumed");
  assert.equal(await bookingCount(second._id), 0);
});

test("H-42 D4-R03 a valid mode is still normalised and stored", async () => {
  const student = await bookableStudent();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student, { testType: "  computer-based  " }),
  });

  assert.equal(res.status, 200, `a valid mode with padding must book (got ${JSON.stringify(res.body)})`);
  const stored = await bookingMockCollection.findOne({ userId: String(student._id) });
  assert.equal(stored.testType, "computer-based", "the mode is stored trimmed as submitted");
  assert.equal(await mockOf(student), 4);
});

test("H-43 D4-R02/R03 a rejected request leaves credit, seat and bookings untouched", async () => {
  const fractionalRows = await studentWith([mr({ mock: 0.5 })], { mock: 1, totalMock: 1 });
  const schedule = await seedSchedule();
  const before = {
    mock: await mockOf(fractionalRows),
    slots: await slotMap(schedule._id),
    bookings: await bookingCount(fractionalRows._id),
  };

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(fractionalRows),
    body: centerBody(fractionalRows, schedule, "1"),
  });

  assert.equal(res.status, 400);
  assert.equal(await mockOf(fractionalRows), before.mock);
  assert.deepEqual(await slotMap(schedule._id), before.slots);
  assert.equal(await bookingCount(fractionalRows._id), before.bookings);
});

// --- D4-R04: requested-test purchase boundary ---------------------------------

/** An MR that is valid in date but was purchased after every test we can book. */
const futurePurchasedMr = (overrides = {}) =>
  mr({
    mock: 1,
    createdAt: new Date("2028-01-01T00:00:00Z"),
    mrValidationExpiry: "2029-12-31T23:59:59Z",
    ...overrides,
  });

/** An MR bought well before the schedulable window, valid through 2027. */
const alreadyPurchasedMr = (overrides = {}) =>
  mr({
    mock: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mrValidationExpiry: "2027-06-01T00:00:00Z",
    ...overrides,
  });

test("H-45 D4-R04 a Home booking cannot spend an MR purchased after the test", async () => {
  const student = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400, "the MR did not exist at the requested test time");
  assert.equal(res.body.message, "Insufficient mock tests available.");
});

test("H-46 D4-R04 a Test Center booking cannot spend an MR purchased after the test", async () => {
  const student = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1"),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Insufficient mock tests available.");
});

test("H-47 D4-R04 a refused future-purchase booking never changes the mock balance", async () => {
  const homeStudent = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });
  const centerStudent = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });
  const schedule = await seedSchedule();

  const homeRes = await api("POST", "/user/book-slot", {
    token: tokenFor(homeStudent),
    body: homeBody(homeStudent),
  });
  const centerRes = await api("POST", "/user/book-slot", {
    token: tokenFor(centerStudent),
    body: centerBody(centerStudent, schedule, "1"),
  });

  assert.equal(homeRes.status, 400);
  assert.equal(centerRes.status, 400);
  assert.equal(await mockOf(homeStudent), 1, "Home refusal spends nothing");
  assert.equal(await mockOf(centerStudent), 1, "Test Center refusal spends nothing");
});

test("H-48 D4-R04 a refused future-purchase booking never takes a Test Center seat", async () => {
  const student = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1"),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await slotMap(schedule._id), { "1": 5, "2": 3 }, "no seat was decremented");
});

test("H-49 D4-R04 a refused future-purchase booking creates no booking document", async () => {
  const student = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(await bookingCount(student._id), 0);
  assert.equal(
    await bookingMockCollection.countDocuments({ userId: String(student._id) }),
    0,
    "not even a cancelled or pending row is written"
  );
});

test("H-50 D4-R04 a refused future-purchase booking sends no confirmation email", async () => {
  const student = await studentWith([futurePurchasedMr()], { mock: 1, totalMock: 1 });
  const before = emailInvocations;

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 400);
  assert.equal(emailInvocations, before, "no email may be attempted for a rejected booking");
});

test("H-51 D4-R04 a Home booking with an already-purchased MR still succeeds", async () => {
  const student = await studentWith([alreadyPurchasedMr()], { mock: 2, totalMock: 2 });

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: homeBody(student),
  });

  assert.equal(res.status, 200, `a purchased MR must still book (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 1);
  assert.equal(await bookingCount(student._id), 1);
});

test("H-52 D4-R04 a Test Center booking with an already-purchased MR still succeeds", async () => {
  const student = await studentWith([alreadyPurchasedMr()], { mock: 2, totalMock: 2 });
  const schedule = await seedSchedule();

  const res = await api("POST", "/user/book-slot", {
    token: tokenFor(student),
    body: centerBody(student, schedule, "1"),
  });

  assert.equal(res.status, 200, `a purchased MR must still book (got ${JSON.stringify(res.body)})`);
  assert.equal(await mockOf(student), 1);
  assert.deepEqual(await slotMap(schedule._id), { "1": 4, "2": 3 }, "exactly one seat was taken");
  assert.equal(await bookingCount(student._id), 1);
});

test("H-53 D4-R04 a future-purchased row cannot be spent concurrently either", async () => {
  // One spendable credit plus a five-credit row bought after the tests: the two
  // concurrent requests may race for the single real credit only.
  const valid = alreadyPurchasedMr({ mock: 1 });
  const future = futurePurchasedMr({ mock: 5 });
  const student = await studentWith([valid, future], { mock: 1, totalMock: 1 });
  const first = await seedSchedule();
  const second = await seedSchedule();

  const [a, b] = await Promise.all([
    api("POST", "/user/book-slot", { token: tokenFor(student), body: centerBody(student, first, "1") }),
    api("POST", "/user/book-slot", { token: tokenFor(student), body: centerBody(student, second, "1") }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status !== 200);
  assert.equal(won.length, 1, `exactly one booking may claim the credit (got ${a.status}/${b.status})`);
  assert.equal(lost.length, 1);
  assert.ok([400, 409].includes(lost[0].status), `loser must be a refusal (got ${lost[0].status})`);
  assert.equal(await mockOf(student), 0, "the balance never goes negative");
  assert.equal(await bookingCount(student._id), 1, "exactly one booking exists");
});

