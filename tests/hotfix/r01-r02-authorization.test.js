"use strict";

/**
 * R01 + R02 acceptance tests — corrective slice for the Day 1/Day 2 review
 * findings (29 Oct 2026). These are NOT new Luminedge requirements; they close
 * two authorization weaknesses found while reviewing the FIX-01/02c/03 work.
 *
 *   R01  GET /api/v1/schedule/:userId had no ownership check (verifyToken only).
 *   R02  verifyAdmin / verifyStaff authorised privileged work from the token's
 *        role without requiring a live-verified identity.
 *
 * SAFETY CONTRACT (shared with the FIX-01/FIX-03 suites, see
 * tests/support/hotfixTestDb.js):
 *   - HOTFIX_TEST_MONGODB_URI is mandatory and must be a dedicated throwaway
 *     instance on a loopback port (27017, the installed service's port, is refused);
 *   - direct connection, no client options, disposable `lumi_hotfix_test_*` db;
 *   - `.env` / `.env.test` are never loaded; synthetic `.invalid` accounts only.
 *
 * Run:
 *   mongod --dbpath <temp-dir> --port 27018 --bind_ip 127.0.0.1
 *   set HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27018
 *   node --test tests/hotfix/r01-r02-authorization.test.js
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

const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("r01r02");

stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;

const createApp = require("../../app");
const { initAuth } = require("../../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let client;
let db;
let usersCollection;
let schedulesCollection;
let server;
let baseUrl;

const COURSE_ID = "synthetic-course-r01";
const DISCOVERY_DATE = "2026-03-10";

// Markers that must never reach a caller who is not the owner or staff.
const MARKERS = {
  aScheduleName: "A own schedule",
  bScheduleName: "B private schedule",
  bEmail: "student.bravo@synthetic.invalid",
};

let studentA;
let studentB;
let admin;
let bdm;
let teacher;

async function seedUser(overrides) {
  const doc = {
    _id: new ObjectId(),
    name: "Synthetic User",
    email: `user.${crypto.randomBytes(4).toString("hex")}@synthetic.invalid`,
    role: "user",
    status: "active",
    isDeleted: false,
    ...overrides,
  };
  await usersCollection.insertOne(doc);
  return doc;
}

function mintToken(userId, overrides = {}, options = {}) {
  return jwt.sign({ userId: String(userId), ...overrides }, JWT_SECRET, {
    expiresIn: "1h",
    ...options,
  });
}

const tokenFor = (user, overrides = {}) =>
  mintToken(user._id, { role: user.role, email: user.email, ...overrides });

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

function assertNoLeak(res, markers, context) {
  const serialized = JSON.stringify(res.body ?? {});
  for (const marker of markers) {
    assert.equal(
      serialized.includes(marker),
      false,
      `${context}: response leaked "${marker}"`
    );
  }
}

before(async () => {
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));
  usersCollection = db.collection("users");
  schedulesCollection = db.collection("schedules");

  studentA = await seedUser({
    name: "Synthetic Student Alpha",
    email: "student.alpha@synthetic.invalid",
    role: "user",
  });
  studentB = await seedUser({
    name: "Synthetic Student Bravo",
    email: MARKERS.bEmail,
    role: "user",
  });
  admin = await seedUser({
    name: "Synthetic Admin",
    email: "admin.staff@synthetic.invalid",
    role: "admin",
  });
  bdm = await seedUser({
    name: "Synthetic BDM",
    email: "bdm.staff@synthetic.invalid",
    role: "bdm",
  });
  teacher = await seedUser({
    name: "Synthetic Teacher",
    email: "teacher.staff@synthetic.invalid",
    role: "teacher",
  });

  // Historical "schedules by userId" rows. The route matches the raw string
  // parameter, so the synthetic rows carry the id as a string — the shape a
  // legacy writer would have produced.
  await schedulesCollection.insertMany([
    {
      _id: new ObjectId(),
      userId: String(studentA._id),
      courseId: COURSE_ID,
      name: MARKERS.aScheduleName,
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      status: "Scheduled",
      timeSlots: [],
    },
    {
      _id: new ObjectId(),
      userId: String(studentB._id),
      courseId: COURSE_ID,
      name: MARKERS.bScheduleName,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
      status: "Scheduled",
      timeSlots: [],
    },
    // A normal course/date discovery row (no userId) used by the non-regression
    // check on GET /schedule/:date/:courseId.
    {
      _id: new ObjectId(),
      courseId: COURSE_ID,
      name: "Discovery row",
      startDate: DISCOVERY_DATE,
      endDate: DISCOVERY_DATE,
      status: "Scheduled",
      timeSlots: [{ slotId: "1", startTime: "09:00", endTime: "12:00", slot: 5 }],
    },
  ]);

  const app = createApp({
    usersCollection,
    coursesCollection: db.collection("courses"),
    schedulesCollection,
    bookingMockCollection: db.collection("bookingMock"),
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
// R01 — GET /schedule/:userId
// ---------------------------------------------------------------------------

test("R1-01 a student cannot read another student's schedules", async () => {
  const res = await api("GET", `/schedule/${studentB._id}`, { token: tokenFor(studentA) });

  assert.equal(res.status, 403);
  assertNoLeak(res, [MARKERS.bScheduleName, MARKERS.bEmail], "cross-student schedules");
  assert.equal(res.body?.schedules, undefined, "no schedule payload may be returned");
});

test("R1-02 the owner keeps access and staff keep their read access", async () => {
  const own = await api("GET", `/schedule/${studentA._id}`, { token: tokenFor(studentA) });
  assert.equal(own.status, 200);
  assert.deepEqual(Object.keys(own.body), ["schedules"], "contract is { schedules }");
  assert.equal(own.body.schedules.length, 1);
  assert.equal(own.body.schedules[0].name, MARKERS.aScheduleName);
  assert.equal(own.body.schedules[0].userId, String(studentA._id));

  for (const staff of [admin, bdm, teacher]) {
    const res = await api("GET", `/schedule/${studentB._id}`, { token: tokenFor(staff) });
    assert.equal(res.status, 200, `${staff.role} must keep staff read access`);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0].name, MARKERS.bScheduleName);
  }
});

test("R1-03 missing, invalid, expired, blocked and deleted tokens are 401", async () => {
  const bId = String(studentB._id);

  assert.equal((await api("GET", `/schedule/${bId}`)).status, 401);
  assert.equal((await api("GET", `/schedule/${bId}`, { token: "not-a-jwt" })).status, 401);
  assert.equal(
    (await api("GET", `/schedule/${bId}`, { token: mintToken(studentA._id, {}, { expiresIn: -60 }) }))
      .status,
    401
  );

  const blocked = await seedUser({
    name: "Synthetic Blocked",
    email: "blocked@synthetic.invalid",
    status: "blocked",
  });
  assert.equal(
    (await api("GET", `/schedule/${String(studentA._id)}`, { token: tokenFor(blocked) })).status,
    401
  );

  const deleted = await seedUser({
    name: "Synthetic Deleted",
    email: "deleted@synthetic.invalid",
    role: "admin",
    isDeleted: true,
  });
  assert.equal(
    (await api("GET", `/schedule/${bId}`, { token: tokenFor(deleted) })).status,
    401,
    "a deleted account cannot read anything, even as a stale admin"
  );
});

test("R1-04 a demoted staff account keeps no schedule access through a stale token", async () => {
  const demoted = await seedUser({
    name: "Synthetic Demoted",
    email: "demoted@synthetic.invalid",
    role: "user", // live role is student...
  });
  // ...but the token still claims the admin role it used to have.
  const staleToken = mintToken(demoted._id, { role: "admin", email: demoted.email });

  const res = await api("GET", `/schedule/${studentB._id}`, { token: staleToken });
  assert.equal(res.status, 403);
  assertNoLeak(res, [MARKERS.bScheduleName], "demoted staff schedules");
});

test("R1-05 the schedule guard fails closed when identity cannot be verified", async () => {
  const adminToken = tokenFor(admin);

  initAuth(null);
  try {
    const staffRes = await api("GET", `/schedule/${studentB._id}`, { token: adminToken });
    assert.equal(staffRes.status, 403, "unverifiable admin identity must not pass");
    assertNoLeak(staffRes, [MARKERS.bScheduleName], "unverifiable staff schedules");

    const ownerRes = await api("GET", `/schedule/${studentA._id}`, { token: adminToken });
    assert.equal(ownerRes.status, 403, "ownership cannot be proved without live identity");
  } finally {
    initAuth(usersCollection);
  }
});

test("R1-06 ObjectId casing cannot dodge or break the schedule ownership check", async () => {
  const token = tokenFor(studentA);

  const other = await api("GET", `/schedule/${String(studentB._id).toUpperCase()}`, { token });
  assert.equal(other.status, 403, "uppercase hex of another user is still refused");
  assertNoLeak(other, [MARKERS.bScheduleName], "uppercase id");

  // Casing must not turn the owner into an intruder. The legacy query itself is
  // an exact string match on `userId` (untouched by R01), so the uppercased id
  // finds no rows — but the caller is authorised, not forbidden.
  const ownUpper = await api("GET", `/schedule/${String(studentA._id).toUpperCase()}`, { token });
  assert.equal(ownUpper.status, 200, "casing must not lock the owner out");
  assert.deepEqual(ownUpper.body, { schedules: [] });

  const ownExact = await api("GET", `/schedule/${String(studentA._id)}`, { token });
  assert.equal(ownExact.status, 200);
  assert.equal(ownExact.body.schedules.length, 1);
  assert.equal(ownExact.body.schedules[0].name, MARKERS.aScheduleName);
});

test("R1-07 course/date schedule discovery is unchanged", async () => {
  // Different arity, a different route, and deliberately NOT owner-scoped: any
  // signed-in student must still be able to list a course's slots for a date.
  const res = await api("GET", `/schedule/${DISCOVERY_DATE}/${COURSE_ID}`, {
    token: tokenFor(studentA),
  });
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.schedules), true);
  assert.equal(res.body.schedules.length, 1);
  assert.equal(res.body.schedules[0].name, "Discovery row");
});

// ---------------------------------------------------------------------------
// R02 — legacy verifyAdmin / verifyStaff fail closed
// ---------------------------------------------------------------------------

test("R2-01 verifyStaff routes keep admin/BDM/teacher access and refuse students", async () => {
  for (const staff of [admin, bdm, teacher]) {
    const users = await api("GET", "/admin/users", { token: tokenFor(staff) });
    assert.equal(users.status, 200, `${staff.role} must reach /admin/users`);
    assert.equal(Array.isArray(users.body.users), true);

    const schedules = await api("GET", "/admin/get-schedules", { token: tokenFor(staff) });
    assert.equal(schedules.status, 200, `${staff.role} must reach /admin/get-schedules`);
    assert.equal(Array.isArray(schedules.body.schedules), true);
  }

  const student = await api("GET", "/admin/users", { token: tokenFor(studentA) });
  assert.equal(student.status, 403);
  assert.deepEqual(student.body, { message: "Forbidden: staff only" });
});

test("R2-02 verifyAdmin routes remain admin-only", async () => {
  const allowed = await api("GET", "/user/all", { token: tokenFor(admin) });
  assert.equal(allowed.status, 200);
  assert.equal(Array.isArray(allowed.body), true, "GET /user/all still returns an array");

  for (const notAdmin of [bdm, teacher, studentA]) {
    const res = await api("GET", "/user/all", { token: tokenFor(notAdmin) });
    assert.equal(res.status, 403, `${notAdmin.role} must not reach an admin-only route`);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  }

  // A second admin-only route, to prove the guard (not the handler) is what
  // refuses the caller: an empty payload reaches the handler and gets 409.
  const reached = await api("POST", "/admin/create-schedule", {
    token: tokenFor(admin),
    body: [],
  });
  assert.equal(reached.status, 409, "an admin reaches the handler");
  const refused = await api("POST", "/admin/create-schedule", {
    token: tokenFor(bdm),
    body: [],
  });
  assert.equal(refused.status, 403, "a BDM never reaches the handler");
});

test("R2-03 both legacy guards fail closed when the live identity is unreadable", async () => {
  // This is the R02 defect: a cryptographically valid admin token used to
  // authorise /admin/users and /user/all even when no account could be read.
  const adminToken = tokenFor(admin);

  initAuth(null);
  try {
    const staffRoute = await api("GET", "/admin/users", { token: adminToken });
    assert.equal(staffRoute.status, 403, "verifyStaff must not fall back to the token claim");
    assert.equal(staffRoute.body?.users, undefined);

    const adminRoute = await api("GET", "/user/all", { token: adminToken });
    assert.equal(adminRoute.status, 403, "verifyAdmin must not fall back to the token claim");
    assert.equal(Array.isArray(adminRoute.body), false, "no user list may leak");

    const scheduleRoute = await api("GET", "/admin/get-schedules", { token: adminToken });
    assert.equal(scheduleRoute.status, 403);
    assert.equal(scheduleRoute.body?.schedules, undefined);
  } finally {
    initAuth(usersCollection);
  }

  // Restored: the same token works again.
  assert.equal((await api("GET", "/admin/users", { token: adminToken })).status, 200);
});

test("R2-04 a stale token role cannot authorise privileged routes", async () => {
  const demoted = await seedUser({
    name: "Synthetic Demoted Staff",
    email: "demoted.staff@synthetic.invalid",
    role: "user",
  });
  const staleToken = mintToken(demoted._id, {
    role: "admin",
    email: demoted.email,
  });

  const staffRoute = await api("GET", "/admin/users", { token: staleToken });
  assert.equal(staffRoute.status, 403, "live role beats the token claim");
  assert.equal(staffRoute.body?.users, undefined);

  const adminRoute = await api("GET", "/user/all", { token: staleToken });
  assert.equal(adminRoute.status, 403);
});

test("R2-05 blocked, deleted, expired and invalid identities are 401 on privileged routes", async () => {
  assert.equal((await api("GET", "/admin/users")).status, 401);
  assert.equal((await api("GET", "/user/all")).status, 401);
  assert.equal((await api("GET", "/admin/users", { token: "garbage" })).status, 401);
  assert.equal(
    (await api("GET", "/admin/users", { token: mintToken(admin._id, { role: "admin" }, { expiresIn: -60 }) }))
      .status,
    401
  );

  const blocked = await seedUser({
    name: "Synthetic Blocked Admin",
    email: "blocked.admin@synthetic.invalid",
    role: "admin",
    status: "blocked",
  });
  assert.equal((await api("GET", "/admin/users", { token: tokenFor(blocked) })).status, 401);
});

test("R2-06 the other guard families were not weakened", async () => {
  // staffOnly (FIX-03): students still refused, staff still allowed.
  const studentTeachers = await api(
    "GET",
    `/admin/assigned-teachers/${studentB._id}/${new ObjectId().toHexString()}`,
    { token: tokenFor(studentA) }
  );
  assert.equal(studentTeachers.status, 403);

  // ownerOrStaff (FIX-03): cross-student read still refused.
  const crossProfile = await api("GET", `/profile/${studentB._id}`, { token: tokenFor(studentA) });
  assert.equal(crossProfile.status, 403);

  // verifyTeacherOrAdmin (FIX-01): a student still cannot write feedback.
  const feedback = await api("POST", "/admin/save-feedback", {
    token: tokenFor(studentA),
    body: {
      userId: String(studentB._id),
      scheduleId: new ObjectId().toHexString(),
      segment: "listening",
      feedback: "synthetic",
    },
  });
  assert.equal(feedback.status, 403);
  assert.equal(feedback.body?.success, false);
});
