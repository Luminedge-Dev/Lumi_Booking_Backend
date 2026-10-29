"use strict";

/**
 * FIX-03 acceptance tests — student data privacy / record ownership.
 *
 * Scope (28 Oct 2026 seven-fix register, FIX-03; PDF pp.7-8, checklist 3.1-3.6):
 *   GET  /api/v1/user/status/:userId
 *   GET  /api/v1/profile/:userId
 *   GET  /api/v1/user/:userId
 *   GET  /api/v1/admin/get-admin-section/:userId/:scheduleId
 *   GET  /api/v1/admin/feedback-status/:userId/:scheduleId
 *   GET  /api/v1/admin/assigned-teachers/:userId/:scheduleId   (staff only)
 *   GET  /api/v1/admin/trf-email-status/:userId/:scheduleId
 *   POST /api/v1/user/request-profile-edit                    (owner from session)
 *
 * SAFETY CONTRACT (shared with the FIX-01 suite, see tests/support/hotfixTestDb.js):
 *   - HOTFIX_TEST_MONGODB_URI is mandatory and must be a dedicated throwaway
 *     instance on a loopback port (27017, the installed service's port, is refused);
 *   - loopback `mongodb://127.0.0.1:<port>` only, direct connection, no client
 *     options may be passed (they cannot override `directConnection`);
 *   - disposable database named `lumi_hotfix_test_fix03_*`, dropped afterwards;
 *   - `.env` / `.env.test` are never loaded and no credential is read or printed;
 *   - synthetic accounts only, on the reserved `.invalid` TLD.
 *
 * Run:
 *   mongod --dbpath <temp-dir> --port 27018 --bind_ip 127.0.0.1
 *   set HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27018
 *   node --test tests/hotfix/fix-03-ownership.test.js
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

// The target is mandatory (HOTFIX_TEST_MONGODB_URI) and must be a dedicated
// throwaway instance; the harness refuses the installed service's port.
const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("fix03");

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
let server;
let baseUrl;

const SCHEDULE_ID = new ObjectId().toHexString();

// Every marker below must never appear in a response to a non-owner.
const MARKERS = {
  bName: "Synthetic Student Bravo",
  bEmail: "student.bravo@synthetic.invalid",
  bPassport: "SYNTH-B-PASSPORT",
  bFeedback: "B private feedback",
  bComment: "B private admin comment",
  bScheme: "B-SCHEME",
  teacherEmails: [
    "teacher.listening@synthetic.invalid",
    "teacher.reading@synthetic.invalid",
    "teacher.writing@synthetic.invalid",
    "teacher.speaking@synthetic.invalid",
  ],
};

let studentA;
let studentB;
let teacher;
let admin;
let bdm;

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

  studentA = await seedUser({
    name: "Synthetic Student Alpha",
    email: "student.alpha@synthetic.invalid",
    role: "user",
    status: "completed",
    contactNo: "01700000001",
    passportNumber: "SYNTH-A-PASSPORT",
    totalMock: 4,
    mock: 3,
    mocks: [
      {
        transactionId: "SYNTH-TX-A",
        mockType: "IELTS",
        testType: "Computer-Based",
        testSystem: "Academic",
        mock: 4,
        mrValidation: "6 months",
      },
    ],
  });

  studentB = await seedUser({
    name: MARKERS.bName,
    email: MARKERS.bEmail,
    role: "user",
    status: "completed",
    contactNo: "01700000002",
    passportNumber: MARKERS.bPassport,
    totalMock: 6,
    mock: 5,
    mocks: [
      {
        transactionId: "SYNTH-TX-B",
        mockType: "IELTS",
        testType: "Computer-Based",
        testSystem: "Academic",
        mock: 6,
        mrValidation: "6 months",
      },
    ],
    profileChangeRequestStatus: "default",
    profileEditNote: null,
    adminSectionBySchedule: {
      [SCHEDULE_ID]: {
        adminComments: MARKERS.bComment,
        schemeCode: MARKERS.bScheme,
        resultDate: "2026-01-05",
        centreName: "Synthetic Centre",
        testDate: "2026-01-03",
      },
    },
    feedbackStatusBySchedule: { [SCHEDULE_ID]: { listening: true } },
    resultsBySchedule: {
      [SCHEDULE_ID]: [
        {
          segment: "listening",
          feedback: MARKERS.bFeedback,
          marks: { L: 7 },
          admin: "Synthetic Examiner",
          timestamp: "2026-01-04T00:00:00.000Z",
        },
      ],
    },
    teachersBySchedule: {
      [SCHEDULE_ID]: {
        teacherLEmail: MARKERS.teacherEmails[0],
        teacherREmail: MARKERS.teacherEmails[1],
        teacherWEmail: MARKERS.teacherEmails[2],
        teacherSEmail: MARKERS.teacherEmails[3],
      },
    },
    trfEmailsBySchedule: {
      [SCHEDULE_ID]: { lastSentAt: "2026-02-02T00:00:00.000Z" },
    },
  });

  teacher = await seedUser({
    name: "Synthetic Teacher",
    email: "teacher.staff@synthetic.invalid",
    role: "teacher",
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

  const app = createApp({
    usersCollection,
    coursesCollection: db.collection("courses"),
    schedulesCollection: db.collection("schedules"),
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
// F3-01 — cross-student reads are refused on all three user record routes
// ---------------------------------------------------------------------------

test("F3-01 student A cannot read student B's status, profile or mock record", async () => {
  const token = tokenFor(studentA);
  const bId = String(studentB._id);

  const endpoints = [
    ["/user/status", `/user/status/${bId}`],
    ["/profile", `/profile/${bId}`],
    ["/user", `/user/${bId}`],
  ];

  for (const [label, path] of endpoints) {
    const res = await api("GET", path, { token });
    assert.equal(res.status, 403, `${label} must refuse another student`);
    assertNoLeak(
      res,
      [MARKERS.bName, MARKERS.bEmail, MARKERS.bPassport, "SYNTH-TX-B"],
      label
    );
  }
});

// ---------------------------------------------------------------------------
// F3-02 — a student keeps full access to their own records
// ---------------------------------------------------------------------------

test("F3-02 student A can read their own records with unchanged contracts", async () => {
  const token = tokenFor(studentA);
  const aId = String(studentA._id);

  const status = await api("GET", `/user/status/${aId}`, { token });
  assert.equal(status.status, 200);
  assert.ok(status.body?.user, "status contract keeps { user }");
  assert.equal(status.body.user.email, "student.alpha@synthetic.invalid");
  assert.equal(status.body.user.password, undefined, "password must never be projected");

  const profile = await api("GET", `/profile/${aId}`, { token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.success, true);
  assert.equal(profile.body.user.email, "student.alpha@synthetic.invalid");
  // Legacy aliases the frontend reads must survive.
  assert.equal(profile.body.user.phone, "01700000001");
  assert.equal(profile.body.user.passportId, "SYNTH-A-PASSPORT");

  const user = await api("GET", `/user/${aId}`, { token });
  assert.equal(user.status, 200);
  assert.equal(user.body.success, true);
  assert.equal(user.body.user.email, "student.alpha@synthetic.invalid");
  assert.equal(user.body.user.totalMock, 4);
  assert.equal(user.body.user.mock, 3);
  assert.equal(Array.isArray(user.body.mocks), true);
  assert.equal(user.body.mocks[0].transactionId, "SYNTH-TX-A");
  assert.ok("lastMock" in user.body, "lastMock key preserved");
});

// ---------------------------------------------------------------------------
// F3-03 — staff retain the access their dashboards need
// ---------------------------------------------------------------------------

test("F3-03 admin, BDM and teacher can still read a student's records", async () => {
  const bId = String(studentB._id);

  for (const staff of [admin, bdm, teacher]) {
    const token = tokenFor(staff);

    const status = await api("GET", `/user/status/${bId}`, { token });
    assert.equal(status.status, 200, `${staff.role} status read`);
    assert.equal(status.body.user.email, MARKERS.bEmail);

    const profile = await api("GET", `/profile/${bId}`, { token });
    assert.equal(profile.status, 200, `${staff.role} profile read`);
    assert.equal(profile.body.user.email, MARKERS.bEmail);

    const user = await api("GET", `/user/${bId}`, { token });
    assert.equal(user.status, 200, `${staff.role} mock read`);
    assert.equal(user.body.user.totalMock, 6);
  }
});

// ---------------------------------------------------------------------------
// F3-04 / F3-05 — the teacher-assignment map is staff-only
// ---------------------------------------------------------------------------

test("F3-04 a student cannot read the assigned-teacher email map", async () => {
  const res = await api(
    "GET",
    `/admin/assigned-teachers/${studentB._id}/${SCHEDULE_ID}`,
    { token: tokenFor(studentA) }
  );

  assert.equal(res.status, 403);
  assert.equal(
    JSON.stringify(res.body ?? {}).includes("@"),
    false,
    "the 403 must not echo any teacher address"
  );
  assertNoLeak(res, MARKERS.teacherEmails, "assigned-teachers");
});

test("F3-05 staff can read the assigned-teacher map", async () => {
  // Even the student's own teacher role is staff, so this is the legitimate use.
  const res = await api(
    "GET",
    `/admin/assigned-teachers/${studentB._id}/${SCHEDULE_ID}`,
    { token: tokenFor(teacher) }
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    teacherL: MARKERS.teacherEmails[0],
    teacherR: MARKERS.teacherEmails[1],
    teacherW: MARKERS.teacherEmails[2],
    teacherS: MARKERS.teacherEmails[3],
  });
});

// ---------------------------------------------------------------------------
// F3-06 / F3-07 — TRF reads: owner-or-staff
// ---------------------------------------------------------------------------

test("F3-06 student A cannot read student B's TRF data", async () => {
  const token = tokenFor(studentA);
  const paths = [
    `/admin/feedback-status/${studentB._id}/${SCHEDULE_ID}`,
    `/admin/get-admin-section/${studentB._id}/${SCHEDULE_ID}`,
    `/admin/trf-email-status/${studentB._id}/${SCHEDULE_ID}`,
  ];

  for (const path of paths) {
    const res = await api("GET", path, { token });
    assert.equal(res.status, 403, `${path} must refuse another student`);
    assertNoLeak(
      res,
      [MARKERS.bFeedback, MARKERS.bComment, MARKERS.bScheme, MARKERS.bName],
      path
    );
  }
});

test("F3-07 a student keeps access to their own TRF data", async () => {
  // Give A its own TRF payload so "own access" is observable, not just a 200.
  await usersCollection.updateOne(
    { _id: studentA._id },
    {
      $set: {
        adminSectionBySchedule: {
          [SCHEDULE_ID]: {
            adminComments: "A own comment",
            schemeCode: "A-SCHEME",
            centreName: "Synthetic Centre",
            testDate: "2026-01-03",
          },
        },
        feedbackStatusBySchedule: { [SCHEDULE_ID]: { listening: true } },
        resultsBySchedule: {
          [SCHEDULE_ID]: [
            {
              segment: "listening",
              feedback: "A own feedback",
              marks: { L: 6 },
              admin: "Synthetic Examiner",
              timestamp: "2026-01-04T00:00:00.000Z",
            },
          ],
        },
      },
    }
  );

  const token = tokenFor(studentA);
  const aId = String(studentA._id);

  const feedback = await api("GET", `/admin/feedback-status/${aId}/${SCHEDULE_ID}`, { token });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.body.success, true);
  assert.equal(feedback.body.status.listeningFeedback, "A own feedback");
  assert.equal(feedback.body.status.listening, true);

  const section = await api("GET", `/admin/get-admin-section/${aId}/${SCHEDULE_ID}`, { token });
  assert.equal(section.status, 200);
  assert.equal(section.body.schemeCode, "A-SCHEME");
  assert.equal(section.body.adminComments, "A own comment");

  const trf = await api("GET", `/admin/trf-email-status/${aId}/${SCHEDULE_ID}`, { token });
  assert.equal(trf.status, 200);
  assert.equal(trf.body.sent, false);
});

test("F3-07b staff can read a student's TRF data", async () => {
  const res = await api(
    "GET",
    `/admin/feedback-status/${studentB._id}/${SCHEDULE_ID}`,
    { token: tokenFor(admin) }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status.listeningFeedback, MARKERS.bFeedback);
});

// ---------------------------------------------------------------------------
// F3-08 / F3-09 / F3-10 — profile-edit ownership
// ---------------------------------------------------------------------------

test("F3-08 a forged body userId cannot touch another student's record", async () => {
  const res = await api("POST", "/user/request-profile-edit", {
    token: tokenFor(studentA),
    body: { userId: String(studentB._id), note: "please change my name" },
  });

  assert.equal(res.status, 200, "the request applies to the caller, not the body");

  const bAfter = await usersCollection.findOne({ _id: studentB._id });
  assert.equal(
    bAfter.profileChangeRequestStatus,
    "default",
    "student B must be untouched"
  );
  assert.equal(bAfter.profileEditNote, null);

  const aAfter = await usersCollection.findOne({ _id: studentA._id });
  assert.equal(aAfter.profileChangeRequestStatus, "requested");
  assert.equal(aAfter.profileEditNote, "please change my name");
});

test("F3-09 a request with no body userId still works (owner from session)", async () => {
  await usersCollection.updateOne(
    { _id: studentA._id },
    { $set: { profileChangeRequestStatus: "default", profileEditNote: null } }
  );

  const res = await api("POST", "/user/request-profile-edit", {
    token: tokenFor(studentA),
    body: { note: "second request" },
  });
  assert.equal(res.status, 200);

  const aAfter = await usersCollection.findOne({ _id: studentA._id });
  assert.equal(aAfter.profileChangeRequestStatus, "requested");
  assert.equal(aAfter.profileEditNote, "second request");
});

test("F3-10 an oversized note is trimmed to 1,000 characters, not rejected (R05)", async () => {
  await usersCollection.updateOne(
    { _id: studentA._id },
    { $set: { profileChangeRequestStatus: "default", profileEditNote: null } }
  );

  const longNote = "x".repeat(1000) + "DISCARDED-TAIL";
  const res = await api("POST", "/user/request-profile-edit", {
    token: tokenFor(studentA),
    body: { note: longNote, userId: String(studentB._id) }, // forged owner still ignored
  });
  assert.equal(res.status, 200, "the audit rule trims an over-long note instead of rejecting it");
  assert.deepEqual(res.body, {
    success: true,
    message: "Profile change request submitted",
  });

  const aAfter = await usersCollection.findOne({ _id: studentA._id });
  assert.equal(aAfter.profileChangeRequestStatus, "requested");
  assert.equal(aAfter.profileEditNote.length, 1000, "stored note is capped at 1,000 characters");
  assert.equal(aAfter.profileEditNote, "x".repeat(1000), "the first 1,000 characters are stored");
  assert.equal(
    aAfter.profileEditNote.includes("DISCARDED-TAIL"),
    false,
    "the tail beyond the cap must not be stored"
  );

  const bAfter = await usersCollection.findOne({ _id: studentB._id });
  assert.equal(bAfter.profileChangeRequestStatus, "default", "student B must be untouched");
  assert.equal(bAfter.profileEditNote, null);
});

test("F3-10b a non-string note is still a safe 400 with nothing written", async () => {
  await usersCollection.updateOne(
    { _id: studentA._id },
    { $set: { profileChangeRequestStatus: "default", profileEditNote: null } }
  );

  for (const note of [{ evil: true }, 42, ["array"]]) {
    const res = await api("POST", "/user/request-profile-edit", {
      token: tokenFor(studentA),
      body: { note },
    });
    assert.equal(res.status, 400, `non-string note ${JSON.stringify(note)} must be rejected`);
    assert.deepEqual(res.body, { success: false, message: "Note must be text" });
  }

  const aAfter = await usersCollection.findOne({ _id: studentA._id });
  assert.equal(aAfter.profileChangeRequestStatus, "default", "nothing was written");
  assert.equal(aAfter.profileEditNote, null);
});

// ---------------------------------------------------------------------------
// Authentication failure modes
// ---------------------------------------------------------------------------

test("F3-11 missing, invalid, expired and blocked tokens are rejected with 401", async () => {
  const aId = String(studentA._id);
  const bId = String(studentB._id);

  const noToken = await api("GET", `/profile/${bId}`);
  assert.equal(noToken.status, 401);

  const garbage = await api("GET", `/profile/${bId}`, { token: "not-a-jwt" });
  assert.equal(garbage.status, 401);

  const expired = await api("GET", `/profile/${bId}`, {
    token: mintToken(studentA._id, {}, { expiresIn: -60 }),
  });
  assert.equal(expired.status, 401);

  const blocked = await seedUser({
    name: "Synthetic Blocked",
    email: "blocked@synthetic.invalid",
    role: "user",
    status: "blocked",
  });
  const blockedRes = await api("GET", `/profile/${aId}`, { token: tokenFor(blocked) });
  assert.equal(blockedRes.status, 401, "a blocked account cannot read anything");

  const deleted = await seedUser({
    name: "Synthetic Deleted",
    email: "deleted@synthetic.invalid",
    role: "admin",
    isDeleted: true,
  });
  const deletedRes = await api("GET", `/user/${bId}`, { token: tokenFor(deleted) });
  assert.equal(deletedRes.status, 401, "a deleted account cannot read anything");

  const anonEdit = await api("POST", "/user/request-profile-edit", {
    body: { note: "anonymous" },
  });
  assert.equal(anonEdit.status, 401);

  const anonTeachers = await api(
    "GET",
    `/admin/assigned-teachers/${bId}/${SCHEDULE_ID}`
  );
  assert.equal(anonTeachers.status, 401);
});

test("F3-12 a demoted staff account keeps no access through a stale token claim", async () => {
  const demoted = await seedUser({
    name: "Synthetic Demoted",
    email: "demoted@synthetic.invalid",
    role: "user", // live role is student...
  });
  // ...but the token still claims the admin role it used to have.
  const staleToken = mintToken(demoted._id, { role: "admin", email: demoted.email });

  const res = await api("GET", `/user/${studentB._id}`, { token: staleToken });
  assert.equal(res.status, 403);
  assertNoLeak(res, [MARKERS.bEmail, MARKERS.bPassport], "demoted staff read");

  const teachersRes = await api(
    "GET",
    `/admin/assigned-teachers/${studentB._id}/${SCHEDULE_ID}`,
    { token: staleToken }
  );
  assert.equal(teachersRes.status, 403);
  assertNoLeak(teachersRes, MARKERS.teacherEmails, "demoted staff teacher map");
});

test("F3-13 guards fail closed when the live identity cannot be verified", async () => {
  // Simulate a runtime where the users collection was never injected: tokens
  // still verify cryptographically, but no live account can be read. Every
  // FIX-03 guard must refuse rather than fall back to the token claims.
  const adminToken = mintToken(admin._id, { role: "admin", email: admin.email });
  const bId = String(studentB._id);

  initAuth(null);
  try {
    const profile = await api("GET", `/profile/${bId}`, { token: adminToken });
    assert.equal(profile.status, 403);

    const teachersRes = await api(
      "GET",
      `/admin/assigned-teachers/${bId}/${SCHEDULE_ID}`,
      { token: adminToken }
    );
    assert.equal(teachersRes.status, 403);

    const edit = await api("POST", "/user/request-profile-edit", {
      token: adminToken,
      body: { note: "unverifiable" },
    });
    assert.equal(edit.status, 403);

    assertNoLeak(profile, [MARKERS.bEmail], "unverifiable identity");
  } finally {
    initAuth(usersCollection); // restore for any later test
  }
});

// ---------------------------------------------------------------------------
// Identifier-casing edge case
// ---------------------------------------------------------------------------

test("F3-14 ObjectId casing cannot be used to dodge or to break ownership", async () => {
  const token = tokenFor(studentA);

  const bUpper = String(studentB._id).toUpperCase();
  const other = await api("GET", `/profile/${bUpper}`, { token });
  assert.equal(other.status, 403, "uppercase hex of another user is still refused");
  assertNoLeak(other, [MARKERS.bEmail], "uppercase id");

  const aUpper = String(studentA._id).toUpperCase();
  const own = await api("GET", `/profile/${aUpper}`, { token });
  assert.equal(own.status, 200, "uppercase hex of your own id still works");
  assert.equal(own.body.user.email, "student.alpha@synthetic.invalid");
});

// ---------------------------------------------------------------------------
// Contract parity for authorized callers
// ---------------------------------------------------------------------------

test("F3-15 authorized responses keep their existing shapes", async () => {
  const bId = String(studentB._id);
  const adminToken = tokenFor(admin);

  const status = await api("GET", `/user/status/${bId}`, { token: adminToken });
  assert.deepEqual(Object.keys(status.body), ["user"]);

  const profile = await api("GET", `/profile/${bId}`, { token: adminToken });
  assert.deepEqual(Object.keys(profile.body).sort(), ["success", "user"]);

  const user = await api("GET", `/user/${bId}`, { token: adminToken });
  assert.deepEqual(
    Object.keys(user.body).sort(),
    ["lastMock", "mocks", "success", "user"],
    "GET /user/:userId contract preserved"
  );

  const feedback = await api("GET", `/admin/feedback-status/${bId}/${SCHEDULE_ID}`, {
    token: adminToken,
  });
  assert.deepEqual(Object.keys(feedback.body).sort(), ["status", "success"]);

  const trf = await api("GET", `/admin/trf-email-status/${bId}/${SCHEDULE_ID}`, {
    token: adminToken,
  });
  assert.equal(trf.body.sent, true);
  assert.equal(trf.body.lastSentAt, "2026-02-02T00:00:00.000Z");
});
