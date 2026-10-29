"use strict";

/**
 * FIX-01 acceptance tests — teacher feedback / marks authorization.
 *
 * Scope: POST /api/v1/admin/save-feedback
 * Authority: 28 Oct 2026 seven-fix register, FIX-01 (PDF pp.2-4, checklist 1.1-1.7)
 *            and context/day-01-fix-01-fix-02-plan.md section B.
 *
 * SAFETY CONTRACT (must not be weakened):
 *   - Runs ONLY against a loopback MongoDB. Any non-loopback URI aborts.
 *   - Uses ONLY a disposable database whose name starts with `lumi_hotfix_test_`.
 *   - Never loads `.env` / `.env.test`; never reads or prints credentials.
 *   - Drops only the disposable database it created.
 *   - Synthetic accounts only, using the reserved `.invalid` TLD.
 *
 * Run:
 *   node --test tests/hotfix/fix-01-feedback.test.js
 *
 * The target URI must be exactly `mongodb://127.0.0.1:<port>` — no credentials,
 * no second host, no SRV, no query options, no database path. The client is
 * created with `directConnection: true`, the suite asserts the connected server
 * reports itself as 127.0.0.1, and it refuses to write into a non-empty
 * database. On this workstation the installed MongoDB *service* only exposes a
 * read-only account, so tests run against a separate throwaway instance:
 *
 *   mongod --dbpath <temp-dir> --port 27018 --bind_ip 127.0.0.1
 *   set HOTFIX_TEST_MONGODB_URI=mongodb://127.0.0.1:27018
 *   node --test tests/hotfix/fix-01-feedback.test.js
 *
 * Then stop that mongod and delete <temp-dir>. Never point this at a shared
 * cluster; the guards below will refuse it. Do not paste credentials here.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const {
  TEST_DB_PREFIX,
  DEFAULT_LOOPBACK_URI,
  SHARED_SERVICE_PORT,
  STRICT_LOOPBACK_URI,
  SAFE_CLIENT_OPTIONS,
  assertLoopbackMongoUri,
  assertDedicatedMongoTarget,
  resolveTestMongoUri,
  assertDisposableDbName,
  disposableDbName,
  stripInheritedMongoEnv,
  connectDisposable,
} = require("../support/hotfixTestDb");

// Database safety (strict single-host loopback URI, dedicated throwaway port,
// disposable name prefix, direct connection, refusal to reuse a non-empty
// database) lives in tests/support/hotfixTestDb.js so every hotfix suite shares
// one hardened guard. The target is mandatory — there is no fallback to the
// installed service.
const SAFE_LOOPBACK_URI = resolveTestMongoUri();
const TEST_DB_NAME = disposableDbName("fix01");

// Strip any inherited production connection details BEFORE application modules
// are imported, so nothing can fall back to a shared cluster even by accident.
stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;

const createApp = require("../../app");

const JWT_SECRET = process.env.JWT_SECRET;

// ---------------------------------------------------------------------------
// Fixtures and lifecycle
// ---------------------------------------------------------------------------

let client;
let db;
let usersCollection;
let server;
let baseUrl;

const FEEDBACK_URL = () => `${baseUrl}/api/v1/admin/save-feedback`;

function mintToken(userId, overrides = {}) {
  return jwt.sign(
    { userId: String(userId), ...overrides },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function newScheduleId() {
  return new ObjectId().toHexString();
}

/**
 * Insert a synthetic account. `assignment` adds a teachersBySchedule entry so
 * the per-segment assignment check has something real to evaluate.
 */
async function seedUser({ role, email, assignment = null, extra = {} }) {
  const doc = {
    _id: new ObjectId(),
    name: `Synthetic ${role}`,
    email,
    role,
    status: "active",
    isDeleted: false,
    ...extra,
  };
  if (assignment) {
    const { scheduleId, emails } = assignment;
    doc.teachersBySchedule = {
      [scheduleId]: {
        teacherL: "Synthetic L",
        teacherLEmail: emails.listening,
        teacherR: "Synthetic R",
        teacherREmail: emails.reading,
        teacherW: "Synthetic W",
        teacherWEmail: emails.writing,
        teacherS: "Synthetic S",
        teacherSEmail: emails.speaking,
      },
    };
  }
  await usersCollection.insertOne(doc);
  return doc;
}

function listeningPayload(userId, scheduleId, overrides = {}) {
  return {
    userId: String(userId),
    scheduleId,
    segment: "listening",
    feedback: "Synthetic feedback",
    marks: { L: 7 },
    admin: "Synthetic Examiner",
    ...overrides,
  };
}

async function saveFeedback(payload, token) {
  const headers = { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(FEEDBACK_URL(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function reload(userId) {
  return usersCollection.findOne({ _id: new ObjectId(String(userId)) });
}

before(async () => {
  // connectDisposable re-asserts the URI + name, forces a direct connection,
  // proves the socket is loopback, and refuses a non-empty database.
  ({ client, db } = await connectDisposable(SAFE_LOOPBACK_URI, TEST_DB_NAME));

  usersCollection = db.collection("users");

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
    // Drop ONLY the disposable database this suite created.
    try {
      if (db) await db.dropDatabase();
    } catch (err) {
      console.error("WARNING: could not drop disposable test database:", err.message);
    }
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Safety guard self-tests
// ---------------------------------------------------------------------------

test("safety: rejects every unsafe MongoDB connection string before connecting", () => {
  // Each entry is a URI a careless agent/CI job might supply. None may be
  // accepted: a test run must never be able to reach a shared cluster.
  const unsafe = [
    ["", "empty value"],
    ["   ", "whitespace only"],
    ["mongodb+srv://user:redacted@cluster0.example.mongodb.net", "SRV discovery"],
    ["mongodb+srv://127.0.0.1", "SRV on a loopback name"],
    ["mongodb://127.0.0.1:27017,10.20.30.40:27017", "second host is remote"],
    ["mongodb://127.0.0.1:27017,127.0.0.1:27018", "second host is loopback"],
    ["mongodb://user:redacted@127.0.0.1:27017", "credentials"],
    ["mongodb://127.0.0.1:27017/?proxyHost=10.20.30.40:27017", "proxyHost option"],
    ["mongodb://127.0.0.1:27017/?replicaSet=remote", "replicaSet option"],
    ["mongodb://127.0.0.1:27017?directConnection=true", "query string of any kind"],
    ["mongodb://127.0.0.1:27017/luminedge", "database path"],
    ["mongodb://127.0.0.1:27017/", "trailing slash"],
    ["mongodb://localhost:27017", "DNS name"],
    ["mongodb://[::1]:27017", "IPv6 literal"],
    ["mongodb://0.0.0.0:27017", "wildcard bind address"],
    ["mongodb://10.20.30.40:27017", "remote IPv4"],
    ["mongodb://db.internal:27017", "remote hostname"],
    ["mongodb://127.0.0.1", "missing port"],
    ["mongodb://127.0.0.1:0", "port 0"],
    ["mongodb://127.0.0.1:70000", "port out of range"],
    ["http://127.0.0.1:27017", "wrong scheme"],
    ["mongodb://127.0.0.1:27017#fragment", "fragment"],
  ];

  for (const [uri, label] of unsafe) {
    assert.throws(
      () => assertLoopbackMongoUri(uri),
      /Refusing to run/,
      `expected "${uri}" (${label}) to be refused`
    );
  }

  // The single accepted shape still works, and is returned unchanged.
  assert.equal(assertLoopbackMongoUri("mongodb://127.0.0.1:27018"), "mongodb://127.0.0.1:27018");
  assert.equal(assertLoopbackMongoUri(DEFAULT_LOOPBACK_URI), DEFAULT_LOOPBACK_URI);

  // Disposable database namespace is mandatory.
  assert.throws(() => assertDisposableDbName("luminedge"), /Refusing to run/);
  assert.throws(() => assertDisposableDbName("admin"), /Refusing to run/);
  assert.throws(() => assertDisposableDbName(TEST_DB_PREFIX), /Refusing to run/);
  assert.equal(
    assertDisposableDbName(`${TEST_DB_PREFIX}fix01_ok`),
    `${TEST_DB_PREFIX}fix01_ok`
  );
});

test("safety (R03): connection options cannot override the enforced defaults", async () => {
  // Regression guard for the Day-2 review finding: the client used to be built
  // as `{ ...SAFE_CLIENT_OPTIONS, ...options }`, so a caller could pass
  // `{ directConnection: false }` (or a proxyHost) and re-enable topology
  // discovery. Options are no longer accepted at all.
  await assert.rejects(
    () =>
      connectDisposable("mongodb://127.0.0.1:27018", `${TEST_DB_PREFIX}opts`, {
        directConnection: false,
      }),
    /Refusing to run: connectDisposable\(uri, dbName\) accepts no client options/,
    "a client-options override must be refused before any socket is opened"
  );
  await assert.rejects(
    () =>
      connectDisposable("mongodb://127.0.0.1:27018", `${TEST_DB_PREFIX}opts`, {
        serverSelectionTimeoutMS: 1,
      }),
    /accepts no client options/
  );

  // The frozen defaults themselves are immutable.
  assert.equal(Object.isFrozen(SAFE_CLIENT_OPTIONS), true);
  assert.throws(() => {
    SAFE_CLIENT_OPTIONS.directConnection = false;
  }, TypeError);
  assert.equal(SAFE_CLIENT_OPTIONS.directConnection, true);
});

test("safety (R03): the installed service port is never a test target", () => {
  // 27017 belongs to whatever MongoDB the workstation has installed. A test run
  // must be an explicitly provisioned throwaway instance instead.
  assert.equal(SHARED_SERVICE_PORT, 27017);
  assert.throws(
    () => assertDedicatedMongoTarget("mongodb://127.0.0.1:27017"),
    /port 27017 is the default MongoDB port of the installed service/,
    "port 27017 must be refused even though it is loopback"
  );
  assert.throws(
    () => resolveTestMongoUri("mongodb://127.0.0.1:27017"),
    /port 27017 is the default MongoDB port of the installed service/
  );
  // An alternate loopback port is still accepted.
  assert.equal(
    assertDedicatedMongoTarget("mongodb://127.0.0.1:27018"),
    "mongodb://127.0.0.1:27018"
  );

  // connectDisposable refuses the installed service too — and refuses it BEFORE
  // opening a socket, so the running service is never touched by a test run.
  return assert.rejects(
    () => connectDisposable(DEFAULT_LOOPBACK_URI, `${TEST_DB_PREFIX}shared_service`),
    /port 27017 is the default MongoDB port of the installed service/
  );
});

test("safety (R03): the target is mandatory, never defaulted", () => {
  // And there is no silent default: an unset variable is an error.
  assert.throws(
    () => resolveTestMongoUri(""),
    /HOTFIX_TEST_MONGODB_URI is not set/
  );
  assert.throws(
    () => resolveTestMongoUri("   "),
    /HOTFIX_TEST_MONGODB_URI is not set/
  );
  const saved = process.env.HOTFIX_TEST_MONGODB_URI;
  try {
    delete process.env.HOTFIX_TEST_MONGODB_URI;
    assert.throws(() => resolveTestMongoUri(), /HOTFIX_TEST_MONGODB_URI is not set/);
  } finally {
    if (saved !== undefined) process.env.HOTFIX_TEST_MONGODB_URI = saved;
  }
});

test("safety: connection is direct and terminated on a local writable node", () => {
  assert.equal(SAFE_CLIENT_OPTIONS.directConnection, true, "topology discovery must be off");
  assert.match(SAFE_LOOPBACK_URI, STRICT_LOOPBACK_URI);
  assert.ok(db, "no connection");
});

// ---------------------------------------------------------------------------
// F1-01 / F1-02 — students and BDMs cannot write feedback
// ---------------------------------------------------------------------------

test("F1-01 student token is rejected with 403 and writes nothing", async () => {
  const assignedEmail = "teacher.a@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const student = await seedUser({ role: "user", email: "student.caller@synthetic.invalid" });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId, { adminEmail: assignedEmail }),
    mintToken(student._id, { role: "user", email: student.email })
  );

  assert.equal(res.status, 403);
  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined);
  assert.equal(stored.feedbackStatusBySchedule, undefined);
});

test("F1-02 BDM token is rejected with 403 and writes nothing", async () => {
  const assignedEmail = "teacher.b@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target2@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const bdm = await seedUser({ role: "bdm", email: "bdm.caller@synthetic.invalid" });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId, { adminEmail: assignedEmail }),
    mintToken(bdm._id, { role: "bdm", email: bdm.email })
  );

  assert.equal(res.status, 403);
  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined);
});

// ---------------------------------------------------------------------------
// F1-03 — unassigned teacher, no assigned-email disclosure
// ---------------------------------------------------------------------------

test("F1-03 unassigned teacher gets 403 without leaking the assigned email", async () => {
  const assignedEmail = "teacher.assigned@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target3@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const outsider = await seedUser({ role: "teacher", email: "teacher.outsider@synthetic.invalid" });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId),
    mintToken(outsider._id, { role: "teacher", email: outsider.email })
  );

  assert.equal(res.status, 403);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("@"), "response must not echo any email address");
  assert.ok(!serialized.includes(assignedEmail), "response must not disclose the assigned teacher");

  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined);
});

// ---------------------------------------------------------------------------
// F1-04 / F1-05 — assigned teacher succeeds once, then conflicts
// ---------------------------------------------------------------------------

test("F1-04 assigned teacher saves once; body adminEmail is ignored", async () => {
  const assignedEmail = "teacher.owner@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target4@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });

  const res = await saveFeedback(
    // Deliberately forged body identity: must not be consulted.
    listeningPayload(target._id, scheduleId, { adminEmail: "attacker@synthetic.invalid" }),
    mintToken(teacher._id, { role: "teacher", email: teacher.email })
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, message: "Feedback saved successfully." });

  const stored = await reload(target._id);
  const entries = stored.resultsBySchedule?.[scheduleId];
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 1, "exactly one result entry");
  assert.equal(entries[0].segment, "listening");
  assert.equal(entries[0].feedback, "Synthetic feedback");
  assert.deepEqual(entries[0].marks, { L: 7 });
  assert.equal(typeof entries[0].timestamp, "string");
  assert.equal(stored.feedbackStatusBySchedule?.[scheduleId]?.listening, true);
});

test("F1-05 duplicate submission returns 409 and adds no second entry", async () => {
  const assignedEmail = "teacher.dup@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target5@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });
  const token = mintToken(teacher._id, { role: "teacher", email: teacher.email });
  const payload = listeningPayload(target._id, scheduleId);

  const first = await saveFeedback(payload, token);
  assert.equal(first.status, 200);

  const second = await saveFeedback(payload, token);
  assert.equal(second.status, 409);

  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule[scheduleId].length, 1);
});

// ---------------------------------------------------------------------------
// F1-06 — concurrency: exactly one winner
// ---------------------------------------------------------------------------

test("F1-06 concurrent first submissions yield exactly one 200 and the rest 409", async () => {
  const assignedEmail = "teacher.race@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target6@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });
  const token = mintToken(teacher._id, { role: "teacher", email: teacher.email });
  const payload = listeningPayload(target._id, scheduleId);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => saveFeedback(payload, token))
  );
  const statuses = results.map((r) => r.status).sort((a, b) => a - b);

  assert.deepEqual(
    statuses,
    [200, 409, 409, 409, 409],
    `expected exactly one winner, got ${statuses.join(",")}`
  );

  const stored = await reload(target._id);
  const entries = stored.resultsBySchedule?.[scheduleId] || [];
  assert.equal(entries.length, 1, "concurrent duplicates must not both be stored");
  assert.equal(stored.feedbackStatusBySchedule?.[scheduleId]?.listening, true);
});

test("F1-06b the conditional predicate is a sound lock (direct DB-level race)", async () => {
  // Scope: proves the *predicate* used by the route is sound — two writes that
  // both carry it cannot both match, and the flag plus the result entry stay in
  // step. Whether the route actually uses that predicate is a different
  // property, covered end-to-end by F1-06 above (which fails if the route's
  // filter is weakened to `{ _id }`).
  const userId = new ObjectId();
  const scheduleId = newScheduleId();
  await usersCollection.insertOne({
    _id: userId,
    name: "Synthetic race target",
    email: "student.race.direct@synthetic.invalid",
    role: "user",
    status: "active",
    isDeleted: false,
  });

  const flagPath = `feedbackStatusBySchedule.${scheduleId}.listening`;
  const resultsPath = `resultsBySchedule.${scheduleId}`;
  const filter = {
    _id: userId,
    [flagPath]: { $ne: true },
    [`${resultsPath}.segment`]: { $ne: "listening" },
  };
  const update = {
    $push: { [resultsPath]: { segment: "listening", feedback: "race", marks: null, admin: null, timestamp: new Date().toISOString() } },
    $set: { [flagPath]: true },
  };

  const [first, second] = await Promise.all([
    usersCollection.updateOne(filter, update),
    usersCollection.updateOne(filter, update),
  ]);

  assert.equal(
    (first.matchedCount || 0) + (second.matchedCount || 0),
    1,
    "exactly one conditional write may match"
  );

  const stored = await usersCollection.findOne({ _id: userId });
  assert.equal(stored.resultsBySchedule[scheduleId].length, 1);
  assert.equal(stored.feedbackStatusBySchedule[scheduleId].listening, true);
});

// ---------------------------------------------------------------------------
// F1-07 — invalid identifiers/segments rejected before any write
// ---------------------------------------------------------------------------

test("F1-07 invalid userId, scheduleId and segment return 400 with no writes", async () => {
  const assignedEmail = "teacher.invalid@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target7@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });
  const token = mintToken(teacher._id, { role: "teacher", email: teacher.email });

  const badUserId = await saveFeedback(
    listeningPayload("not-an-object-id", scheduleId),
    token
  );
  assert.equal(badUserId.status, 400);

  // Dot in a dynamic key path would create a nested field if it slipped through.
  const badSchedule = await saveFeedback(
    listeningPayload(target._id, "a.b"),
    token
  );
  assert.equal(badSchedule.status, 400);

  const badScheduleLong = await saveFeedback(
    listeningPayload(target._id, "x".repeat(65)),
    token
  );
  assert.equal(badScheduleLong.status, 400);

  const badSegment = await saveFeedback(
    listeningPayload(target._id, scheduleId, { segment: "hacked" }),
    token
  );
  assert.equal(badSegment.status, 400);

  const missingFeedback = await saveFeedback(
    listeningPayload(target._id, scheduleId, { feedback: undefined }),
    token
  );
  assert.equal(missingFeedback.status, 400);

  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined, "no results were written");
  assert.equal(stored.feedbackStatusBySchedule, undefined, "no flags were written");
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored, "resultsBySchedule"),
    false,
    "dynamic schedule key must not have created a field"
  );
});

// ---------------------------------------------------------------------------
// Admin parity: assignment is required even for admins
// ---------------------------------------------------------------------------

test("admin assigned to the segment succeeds", async () => {
  const assignedEmail = "admin.also.teacher@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target8@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const admin = await seedUser({ role: "admin", email: assignedEmail });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId),
    mintToken(admin._id, { role: "admin", email: admin.email })
  );

  assert.equal(res.status, 200);
  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule[scheduleId].length, 1);
});

test("BDM whose email matches the assignment is still rejected by the role guard", async () => {
  const assignedEmail = "bdm.match@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target9b@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  // Live role is `bdm`, but the email does match the segment assignment.
  // Only the role guard can stop this write, so this test fails if the
  // teacher/admin restriction is removed from the route.
  const bdm = await seedUser({ role: "bdm", email: assignedEmail });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId),
    mintToken(bdm._id, { role: "bdm", email: bdm.email })
  );

  assert.equal(res.status, 403);
  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined, "role guard must block the write");
});

test("admin who is not the assigned teacher is rejected with 403", async () => {
  const assignedEmail = "teacher.only@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target9@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const admin = await seedUser({ role: "admin", email: "admin.other@synthetic.invalid" });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId, { adminEmail: assignedEmail }),
    mintToken(admin._id, { role: "admin", email: admin.email })
  );

  assert.equal(res.status, 403);
  assert.ok(!JSON.stringify(res.body).includes(assignedEmail));
  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined);
});

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

test("missing and invalid tokens are rejected with 401", async () => {
  const scheduleId = newScheduleId();
  const target = await seedUser({ role: "user", email: "student.target10@synthetic.invalid" });

  const noToken = await saveFeedback(listeningPayload(target._id, scheduleId), null);
  assert.equal(noToken.status, 401);

  const badToken = await saveFeedback(listeningPayload(target._id, scheduleId), "not-a-jwt");
  assert.equal(badToken.status, 401);
});

test("token email claim cannot override the live database identity", async () => {
  const assignedEmail = "teacher.live@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target11@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });

  // Outsider whose TOKEN claims the assigned teacher's email: must fail,
  // because the live account email is what counts.
  const outsider = await seedUser({ role: "teacher", email: "teacher.spoof@synthetic.invalid" });
  const forgedToken = mintToken(outsider._id, { role: "teacher", email: assignedEmail });
  const forged = await saveFeedback(listeningPayload(target._id, scheduleId), forgedToken);
  assert.equal(forged.status, 403);

  let stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule, undefined);

  // Assigned teacher whose TOKEN claims someone else: must still succeed.
  const owner = await seedUser({ role: "teacher", email: assignedEmail });
  const staleToken = mintToken(owner._id, { role: "teacher", email: "stale@synthetic.invalid" });
  const ok = await saveFeedback(listeningPayload(target._id, scheduleId), staleToken);
  assert.equal(ok.status, 200);

  stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule[scheduleId].length, 1);
});

test("a live account whose token role was demoted cannot write", async () => {
  const assignedEmail = "teacher.demoted@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target12@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  // Live role is `user` but the token still claims `teacher`.
  const demoted = await seedUser({ role: "user", email: assignedEmail });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId),
    mintToken(demoted._id, { role: "teacher", email: demoted.email })
  );

  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Legacy data compatibility
// ---------------------------------------------------------------------------

test("legacy result without a status flag is treated as a conflict, not a missing user", async () => {
  const assignedEmail = "teacher.legacy@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target13@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
    extra: {
      // Pre-fix data shape: a stored result, but no per-segment status flag.
      resultsBySchedule: {
        [scheduleId]: [
          {
            segment: "listening",
            feedback: "Legacy feedback that predates the flag",
            marks: { L: 6 },
            admin: "Synthetic Examiner",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });

  const res = await saveFeedback(
    listeningPayload(target._id, scheduleId),
    mintToken(teacher._id, { role: "teacher", email: teacher.email })
  );

  assert.equal(res.status, 409, "legacy duplicate must not overwrite or duplicate");
  assert.ok(!JSON.stringify(res.body).includes("User not found"));

  const stored = await reload(target._id);
  assert.equal(stored.resultsBySchedule[scheduleId].length, 1);
  assert.equal(
    stored.resultsBySchedule[scheduleId][0].feedback,
    "Legacy feedback that predates the flag"
  );
});

// ---------------------------------------------------------------------------
// Backward compatibility with existing clients
// ---------------------------------------------------------------------------

test("existing clients that omit adminEmail still succeed", async () => {
  const assignedEmail = "teacher.compat@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target14@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });

  const payload = listeningPayload(target._id, scheduleId);
  delete payload.adminEmail;

  const res = await saveFeedback(payload, mintToken(teacher._id, { role: "teacher", email: teacher.email }));
  assert.equal(res.status, 200);
});

test("writing segment keeps its signature and format requirements", async () => {
  const assignedEmail = "teacher.writing@synthetic.invalid";
  const scheduleId = newScheduleId();
  const target = await seedUser({
    role: "user",
    email: "student.target15@synthetic.invalid",
    assignment: {
      scheduleId,
      emails: {
        listening: assignedEmail,
        reading: assignedEmail,
        writing: assignedEmail,
        speaking: assignedEmail,
      },
    },
  });
  const teacher = await seedUser({ role: "teacher", email: assignedEmail });
  const token = mintToken(teacher._id, { role: "teacher", email: teacher.email });

  const base = {
    userId: String(target._id),
    scheduleId,
    segment: "writing",
    feedback: { task1: "Synthetic" },
    marks: { W: 6.5 },
  };

  const noSignature = await saveFeedback(base, token);
  assert.equal(noSignature.status, 400);

  const ok = await saveFeedback({ ...base, admin: "Synthetic Examiner" }, token);
  assert.equal(ok.status, 200);

  const stored = await reload(target._id);
  assert.equal(stored.feedbackStatusBySchedule[scheduleId].writing, true);
});
