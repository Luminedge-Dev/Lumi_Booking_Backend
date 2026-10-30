"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const {
  resolveTestMongoUri, disposableDbName, stripInheritedMongoEnv, connectDisposable,
} = require("../support/hotfixTestDb");
const reminder = require("../../utils/reminderDelivery");
const emailModule = require("../../emailSender");

const mongoUri = resolveTestMongoUri();
const dbName = disposableDbName("fix05reminder");
stripInheritedMongoEnv();
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.CRON_SECRET = crypto.randomBytes(32).toString("hex");
process.env.PUBLIC_API_URL = "http://127.0.0.1:1";
delete process.env.CORS_ORIGINS;
for (const key of ["SMTP_HOST", "EMAIL", "SMTP_EMAIL", "APP_PASS", "SMTP_APP_PASS"]) delete process.env[key];

const originalBulk = emailModule.emailSenderBulk;
let sends = [];
let smtpResponder = async (items) => items.map(() => ({ success: true }));
emailModule.emailSenderBulk = async (items) => {
  sends.push(...items);
  return smtpResponder(items);
};
const createApp = require("../../app");
const nativeFetch = global.fetch;

let client;
let db;
let users;
let schedules;
let bookings;
let deliveries;
let server;
let baseUrl;

function tokenFor(user) {
  return jwt.sign({ userId: String(user._id), role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function api(path, { token, body, headers = {} } = {}) {
  const requestHeaders = { "X-Forwarded-For": "127.0.0.1", ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await nativeFetch(`${baseUrl}/api/v1${path}`, {
    method: "POST", headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function seedUser(overrides = {}) {
  const user = {
    _id: new ObjectId(), name: "<Student & One>", email: `fix05.${crypto.randomUUID()}@synthetic.invalid`,
    role: "user", status: "completed", isDeleted: false, ...overrides,
  };
  await users.insertOne(user);
  return user;
}

async function seedSchedule() {
  const schedule = {
    _id: new ObjectId(), name: "IELTS Academic", courseId: "synthetic-course",
    startDate: "2030-04-05", testType: "Academic", testSystem: "Computer-Based",
    timeSlots: [
      { slotId: "A", startTime: "09:00:00", endTime: "12:00:00", slot: 2, totalSlot: 2 },
      { slotId: "B", startTime: "13:00:00", endTime: "16:00:00", slot: 2, totalSlot: 2 },
    ],
  };
  await schedules.insertOne(schedule);
  return schedule;
}

async function seedBooking(schedule, user, overrides = {}) {
  const booking = {
    _id: new ObjectId(), scheduleId: String(schedule._id), userId: String(user._id),
    slotId: "A", startTime: "09:00:00", endTime: "12:00:00", bookingDate: schedule.startDate,
    location: "Test Center", name: schedule.name, testType: "Academic", status: "pending", ...overrides,
  };
  await bookings.insertOne(booking);
  return booking;
}

before(async () => {
  ({ client, db } = await connectDisposable(mongoUri, dbName));
  users = db.collection("users");
  schedules = db.collection("schedules");
  bookings = db.collection("bookingMock");
  deliveries = db.collection("reminderDeliveries");
  await users.createIndex({ email: 1 }, { unique: true });
  await deliveries.createIndex({ scheduleId: 1, userId: 1 }, { unique: true, name: "uniq_reminder_schedule_user" });
  const app = createApp({ usersCollection: users, schedulesCollection: schedules, bookingMockCollection: bookings, coursesCollection: db.collection("courses"), reminderDeliveriesCollection: deliveries, client });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) { await db.dropDatabase(); await client.close(); }
  emailModule.emailSenderBulk = originalBulk;
  global.fetch = nativeFetch;
});

test("template escapes dynamic text, uses the actual date/slot and omits obsolete contact/reschedule copy", () => {
  const result = reminder.buildReminderEmail({
    user: { name: "<img src=x onerror=alert(1)>" },
    schedule: { name: "IELTS <script>", startDate: "2030-04-05" },
    booking: { testType: "Academic & General", testSystem: "Computer-Based", location: "Test Center" },
    slot: { startTime: "13:00:00", endTime: "16:00:00" },
  });
  assert.match(result.message, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(result.message, /&lt;script&gt;/);
  assert.match(result.message, /April 5, 2030/);
  assert.match(result.message, /13:00:00–16:00:00/);
  assert.doesNotMatch(result.message, /tomorrow|Gawsia|01400|reschedul/i);
});

test("redacted reminder SMTP failures never log recipient addresses", async () => {
  const captured = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => captured.push(args.join(" "));
  console.log = (...args) => captured.push(args.join(" "));
  const recipient = "private-recipient@synthetic.invalid";
  try {
    await emailModule.emailSender("Reminder", recipient, "<p>test</p>", [], { redactRecipient: true });
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.ok(captured.length > 0);
  assert.doesNotMatch(captured.join("\n"), /private-recipient@synthetic\.invalid/);
});

test("continuation token is purpose-bound, tamper-resistant, expiring and bounded", () => {
  const payload = { scheduleId: new ObjectId().toHexString(), jobId: crypto.randomUUID(), depth: 1, exp: Date.now() + 10_000 };
  const token = reminder.signContinuation(payload, process.env.CRON_SECRET);
  assert.deepEqual(reminder.verifyContinuation(token, process.env.CRON_SECRET), { purpose: "luminedge-reminder-continuation-v1", ...payload });
  assert.equal(reminder.verifyContinuation(`${token}x`, process.env.CRON_SECRET), null);
  assert.equal(reminder.verifyContinuation(token, process.env.CRON_SECRET, Date.now() + 20_000), null);
  const excessive = reminder.signContinuation({ ...payload, depth: 21 }, process.env.CRON_SECRET);
  assert.equal(reminder.verifyContinuation(excessive, process.env.CRON_SECRET), null);
  assert.equal(reminder.configuredPublicApiUrl("http://api.example.com", "production"), null);
  assert.equal(reminder.configuredPublicApiUrl("https://user:pass@api.example.com", "production"), null);
  assert.equal(reminder.configuredPublicApiUrl("https://api.example.com", "production"), "https://api.example.com");
});

test("unique-index readiness accepts only full ascending compound indexes", async () => {
  const valid = { name: "valid", key: { scheduleId: 1, userId: 1 }, unique: true };
  const withIndexes = (indexes) => ({ listIndexes: () => ({ toArray: async () => indexes }) });
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([valid])), true);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, sparse: false }])), true);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, collation: { locale: "en", strength: 1 } }])), true);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, partialFilterExpression: { status: "accepted" } }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, partialFilterExpression: {} }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, partialFilterExpression: undefined }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, sparse: true }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, unique: false }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ key: valid.key }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, key: { userId: 1, scheduleId: 1 } }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, key: { scheduleId: 1, userId: -1 } }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{ ...valid, key: { scheduleId: 1, userId: 1, status: 1 } }])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([{}])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([])), false);
  assert.equal(await reminder.hasRequiredUniqueIndex({ listIndexes: () => ({ toArray: async () => { throw new Error("metadata unavailable"); } }) }), false);
  assert.equal(await reminder.hasRequiredUniqueIndex({ listIndexes: () => { throw new Error("metadata unavailable"); } }), false);
  assert.equal(await reminder.hasRequiredUniqueIndex(withIndexes([
    { ...valid, name: "partial", partialFilterExpression: { status: "accepted" } }, valid,
  ])), true);
});

test("admin-only request rejects client recipients, while other roles never reach SMTP", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const student = await seedUser({ role: "user" });
  const admin = await seedUser({ role: "admin" });
  const bdm = await seedUser({ role: "bdm" });
  const teacher = await seedUser({ role: "teacher" });
  await seedBooking(schedule, student);
  assert.equal((await api("/send-reminder", { body: { scheduleId: String(schedule._id) } })).status, 401);
  for (const user of [student, bdm, teacher]) {
    assert.equal((await api("/send-reminder", { token: tokenFor(user), body: { scheduleId: String(schedule._id) } })).status, 403);
  }
  assert.equal((await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id), emails: [{ email: "outsider@example.invalid", subject: "x", message: "x" }] } })).status, 400);
  assert.equal(sends.length, 0);
});

test("server selects active booked users, verifies per-booking slots and suppresses repeated accepted sends", async () => {
  sends = [];
  smtpResponder = async (items) => items.map(() => ({ success: true }));
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const first = await seedUser({ name: "First <Student>" });
  const second = await seedUser({ name: "Second" });
  const cancelled = await seedUser({ name: "Cancelled" });
  await seedBooking(schedule, first, { slotId: "A", startTime: "09:00:00", endTime: "12:00:00" });
  await seedBooking(schedule, second, { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
  await seedBooking(schedule, cancelled, { status: "cancelled" });
  let sent = [];
  smtpResponder = async (items) => { sent = items; return items.map(() => ({ success: true })); };
  const firstResponse = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.sent, 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((item) => item.to).sort(), [first.email.toLowerCase(), second.email.toLowerCase()].sort());
  assert.match(sent.find((item) => item.to === second.email.toLowerCase()).content, /13:00:00–16:00:00/);
  assert.doesNotMatch(JSON.stringify(firstResponse.body), /@/);
  const repeated = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.alreadyAccepted, 2);
  assert.equal(sent.length, 2);
});

test("bookingIds narrows only eligible bookings and rejects cross-schedule ids", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const other = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const one = await seedUser();
  const two = await seedUser();
  const bookingOne = await seedBooking(schedule, one);
  const bookingTwo = await seedBooking(schedule, two, { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
  const adminToken = tokenFor(admin);
  const narrowed = await api("/send-reminder", { token: adminToken, body: { scheduleId: String(schedule._id), bookingIds: [String(bookingOne._id)] } });
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.sent, 1);
  assert.equal((await api("/send-reminder", { token: adminToken, body: { scheduleId: String(schedule._id), bookingIds: [String(bookingTwo._id), String((await seedBooking(other, await seedUser()))._id)] } })).status, 400);
});

test("consistent duplicate bookings deduplicate, while repeated conflicts stay terminal and do not block other students", async () => {
  sends = [];
  smtpResponder = async (items) => items.map(() => ({ success: true }));
  const admin = await seedUser({ role: "admin" });

  const duplicateSchedule = await seedSchedule();
  const duplicateStudent = await seedUser();
  await seedBooking(duplicateSchedule, duplicateStudent);
  await seedBooking(duplicateSchedule, duplicateStudent);
  const duplicateResponse = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(duplicateSchedule._id) } });
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.body.sent, 1);
  assert.equal(await deliveries.countDocuments({ scheduleId: String(duplicateSchedule._id), userId: String(duplicateStudent._id) }), 1);

  for (const conflictCount of [2, 3, 4]) {
    const schedule = await seedSchedule();
    const ambiguousStudent = await seedUser();
    const validStudent = await seedUser();
    for (let index = 0; index < conflictCount; index += 1) {
      await seedBooking(schedule, ambiguousStudent, index === 0
        ? {}
        : { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
    }
    await seedBooking(schedule, validStudent);
    const cancelledStudent = await seedUser();
    await seedBooking(schedule, cancelledStudent, { status: "cancelled" });

    const before = sends.length;
    const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
    assert.equal(response.status, 200, `${conflictCount} conflicts should not crash or block other recipients`);
    assert.equal(response.body.sent, 1);
    assert.equal(response.body.ineligible, 1);
    assert.equal(sends.length - before, 1);
    assert.equal(sends[before].to, validStudent.email.toLowerCase());
    assert.equal(await deliveries.countDocuments({ scheduleId: String(schedule._id), userId: String(ambiguousStudent._id) }), 0);
    assert.equal(await deliveries.countDocuments({ scheduleId: String(schedule._id), userId: String(cancelledStudent._id) }), 0);
  }
});

test("missing unique index fails closed before SMTP dispatch", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  await deliveries.dropIndex("uniq_reminder_schedule_user");
  const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(response.status, 503);
  assert.equal(sends.length, 0);
  await deliveries.createIndex({ scheduleId: 1, userId: 1 }, { unique: true, name: "uniq_reminder_schedule_user" });
});

test("partial unique reminder index fails closed before claims or SMTP", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  await deliveries.dropIndex("uniq_reminder_schedule_user");
  try {
    await deliveries.createIndex(
      { scheduleId: 1, userId: 1 },
      { unique: true, partialFilterExpression: { status: "accepted" }, name: "uniq_reminder_schedule_user_partial" }
    );
    const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
    assert.equal(response.status, 503);
    assert.equal(sends.length, 0);
    assert.equal(await deliveries.countDocuments({ scheduleId: String(schedule._id) }), 0);
  } finally {
    await deliveries.dropIndex("uniq_reminder_schedule_user_partial").catch(() => {});
    await deliveries.createIndex({ scheduleId: 1, userId: 1 }, { unique: true, name: "uniq_reminder_schedule_user" });
  }
});

test("uncertain SMTP outcomes are not retried by an ordinary repeated request", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  smtpResponder = async (items) => items.map(() => ({ success: false, error: new Error("socket timeout") }));
  const first = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(first.status, 207);
  assert.equal(first.body.uncertain, 1);
  const repeat = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(repeat.body.uncertain, 1);
  assert.equal(sends.length, 1);
});

test("deferred SMTP work returns multi-status without exposing recipients", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  smtpResponder = async (items) => items.map(() => ({ success: false, error: new Error("Skipped: send time budget exceeded") }));
  try {
    const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
    assert.equal(response.status, 207);
    assert.equal(response.body.deferred, 1);
    assert.equal(response.body.continuing, true);
    assert.doesNotMatch(JSON.stringify(response.body), /@/);
  } finally { global.fetch = realFetch; }
});

test("an accepted recipient plus a definitive failure is partial, never total failure", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const acceptedStudent = await seedUser();
  const failedStudent = await seedUser();
  await seedBooking(schedule, acceptedStudent);
  await seedBooking(schedule, failedStudent, { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
  await deliveries.insertOne({
    scheduleId: String(schedule._id), userId: String(acceptedStudent._id), status: "accepted",
    jobId: crypto.randomUUID(), attemptCount: 1, outcome: "smtp_accepted", smtpAcceptedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  });
  smtpResponder = async (items) => items.map(() => ({ success: false, error: new Error("SMTP is not configured") }));
  const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(response.status, 207);
  assert.equal(response.body.alreadyAccepted, 1);
  assert.equal(response.body.failed, 1);
  assert.equal(response.body.sent, 0);
  assert.equal(sends.length, 1);
});

test("legacy userId arrays deduplicate, invalid addresses and ambiguous shared emails are skipped", async () => {
  sends = [];
  smtpResponder = async (items) => items.map(() => ({ success: true }));
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const valid = await seedUser({ email: `Mixed.${crypto.randomUUID()}@synthetic.invalid` });
  const invalid = await seedUser({ email: "not-an-email" });
  const ownerA = await seedUser({ email: `Shared.${crypto.randomUUID()}@synthetic.invalid` });
  const ownerB = await seedUser({ email: ownerA.email.toUpperCase() });
  await seedBooking(schedule, valid, { userId: [String(valid._id), String(valid._id)] });
  await seedBooking(schedule, invalid);
  await seedBooking(schedule, ownerA, { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
  await seedBooking(schedule, ownerB, { slotId: "B", startTime: "13:00:00", endTime: "16:00:00" });
  let attempted = [];
  smtpResponder = async (items) => { attempted = items; return items.map(() => ({ success: true })); };
  const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.invalidRecipients, 1);
  assert.equal(response.body.ineligible, 2);
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].to, valid.email.toLowerCase());
});

test("slot conflicts are skipped instead of guessing, and continuation tokens reject tampering", async () => {
  sends = [];
  const schedule = await seedSchedule();
  await schedules.updateOne({ _id: schedule._id }, { $push: { timeSlots: { slotId: "A", startTime: "10:00:00", endTime: "11:00:00" } } });
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  const result = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, 0);
  assert.equal(result.body.ineligible, 1);
  assert.equal(sends.length, 0);
  const token = reminder.signContinuation({ scheduleId: String(schedule._id), jobId: crypto.randomUUID(), depth: 1, exp: Date.now() + 10_000 }, process.env.CRON_SECRET);
  assert.equal((await api("/send-reminder", { body: { scheduleId: String(schedule._id) }, headers: { "x-reminder-continuation": `${token}x`, Host: "attacker.invalid" } })).status, 401);
});

test("definite SMTP configuration failures require an explicit retry", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  smtpResponder = async (items) => items.map(() => ({ success: false, error: new Error("SMTP is not configured") }));
  const request = { scheduleId: String(schedule._id) };
  const failed = await api("/send-reminder", { token: tokenFor(admin), body: request });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.failed, 1);
  smtpResponder = async (items) => items.map(() => ({ success: true }));
  const suppressed = await api("/send-reminder", { token: tokenFor(admin), body: request });
  assert.equal(suppressed.body.failed, 1);
  assert.equal(sends.length, 1);
  const retried = await api("/send-reminder", { token: tokenFor(admin), body: { ...request, retryFailed: true } });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.sent, 1);
  assert.equal(sends.length, 2);
});

test("missing PUBLIC_API_URL fails closed before sending", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  const oldUrl = process.env.PUBLIC_API_URL;
  delete process.env.PUBLIC_API_URL;
  try {
    const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
    assert.equal(response.status, 503);
    assert.equal(sends.length, 0);
  } finally { process.env.PUBLIC_API_URL = oldUrl; }
});

test("a cancelled booking is revalidated before continuation dispatch", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const student = await seedUser();
  const booking = await seedBooking(schedule, student);
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  try {
    smtpResponder = async (items) => items.map(() => ({ success: false, error: new Error("Skipped: send time budget exceeded") }));
    const initial = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
    assert.equal(initial.body.deferred, 1);
    const row = await deliveries.findOne({ scheduleId: String(schedule._id), userId: String(student._id) });
    await bookings.updateOne({ _id: booking._id }, { $set: { status: "cancelled" } });
    const token = reminder.signContinuation({ scheduleId: String(schedule._id), jobId: row.jobId, depth: 1, exp: Date.now() + 10_000 }, process.env.CRON_SECRET);
    const continuation = await api("/send-reminder", { body: { scheduleId: String(schedule._id) }, headers: { "x-reminder-continuation": token } });
    assert.equal(continuation.body.ineligible, 1);
    assert.equal(sends.length, 1);
    assert.equal((await deliveries.findOne({ _id: row._id })).status, "ineligible");
  } finally { global.fetch = realFetch; }
});

test("atomic ledger claims suppress simultaneous reminder requests", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  await seedBooking(schedule, await seedUser());
  let entered;
  const dispatchStarted = new Promise((resolve) => { entered = resolve; });
  let finishDispatch;
  let dispatchCalls = 0;
  smtpResponder = async (items) => {
    dispatchCalls += 1;
    if (dispatchCalls === 1) {
      entered();
      await new Promise((resolve) => { finishDispatch = resolve; });
    }
    return items.map(() => ({ success: true }));
  };
  const firstRequest = api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  await dispatchStarted;
  const secondRequest = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(secondRequest.status, 207);
  assert.equal(secondRequest.body.processing, 1);
  assert.equal(sends.length, 1);
  finishDispatch();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.status, 200);
  assert.equal(sends.length, 1);
});

test("expired processing leases become uncertain and are never automatically resent", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const admin = await seedUser({ role: "admin" });
  const student = await seedUser();
  await seedBooking(schedule, student);
  await deliveries.insertOne({
    scheduleId: String(schedule._id), userId: String(student._id), status: "processing",
    jobId: crypto.randomUUID(), attemptCount: 1, leaseOwner: "expired-worker",
    leaseExpiresAt: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date(),
  });
  const response = await api("/send-reminder", { token: tokenFor(admin), body: { scheduleId: String(schedule._id) } });
  assert.equal(response.status, 207);
  assert.equal(response.body.uncertain, 1);
  assert.equal((await deliveries.findOne({ scheduleId: String(schedule._id), userId: String(student._id) })).status, "uncertain");
  assert.equal(sends.length, 0);
});

test("replayed continuation cannot claim an already leased reminder", async () => {
  sends = [];
  const schedule = await seedSchedule();
  const student = await seedUser();
  const booking = await seedBooking(schedule, student);
  const jobId = `reminder:${String(schedule._id)}`;
  await deliveries.insertOne({
    scheduleId: String(schedule._id), userId: String(student._id), status: "deferred", jobId,
    bookingId: String(booking._id), attemptCount: 0, outcome: "not_attempted", createdAt: new Date(), updatedAt: new Date(),
  });
  const token = reminder.signContinuation({ scheduleId: String(schedule._id), jobId, depth: 1, exp: Date.now() + 10_000 }, process.env.CRON_SECRET);
  let entered;
  const dispatchStarted = new Promise((resolve) => { entered = resolve; });
  let finishDispatch;
  let dispatchCalls = 0;
  smtpResponder = async (items) => {
    dispatchCalls += 1;
    if (dispatchCalls === 1) {
      entered();
      await new Promise((resolve) => { finishDispatch = resolve; });
    }
    return items.map(() => ({ success: true }));
  };
  const headers = { "x-reminder-continuation": token };
  const firstRequest = api("/send-reminder", { body: { scheduleId: String(schedule._id) }, headers });
  await dispatchStarted;
  const replay = await api("/send-reminder", { body: { scheduleId: String(schedule._id) }, headers });
  assert.equal(replay.status, 207);
  assert.equal(replay.body.processing, 1);
  assert.equal(sends.length, 1);
  finishDispatch();
  assert.equal((await firstRequest).status, 200);
  assert.equal(sends.length, 1);
});

test("concurrent continuations that read the same deferred row still have one atomic claimant", async () => {
  sends = [];
  smtpResponder = async (items) => items.map(() => ({ success: true }));
  const schedule = await seedSchedule();
  const student = await seedUser();
  const booking = await seedBooking(schedule, student);
  const jobId = `reminder:${String(schedule._id)}`;
  await deliveries.insertOne({
    scheduleId: String(schedule._id), userId: String(student._id), status: "deferred", jobId,
    bookingId: String(booking._id), attemptCount: 0, outcome: "not_attempted", createdAt: new Date(), updatedAt: new Date(),
  });
  const token = reminder.signContinuation({ scheduleId: String(schedule._id), jobId, depth: 1, exp: Date.now() + 10_000 }, process.env.CRON_SECRET);
  const headers = { "x-reminder-continuation": token };
  const originalFind = deliveries.find.bind(deliveries);
  let snapshots = 0;
  let releaseSnapshots;
  const bothSnapshotsReady = new Promise((resolve) => { releaseSnapshots = resolve; });
  deliveries.find = (filter, options) => {
    const cursor = originalFind(filter, options);
    if (filter?.scheduleId === String(schedule._id) && filter?.jobId === jobId && !filter.status && !filter.userId) {
      const snapshot = cursor.toArray();
      return {
        toArray: async () => {
          const rows = await snapshot;
          snapshots += 1;
          if (snapshots === 2) releaseSnapshots();
          await bothSnapshotsReady;
          return rows;
        },
      };
    }
    return cursor;
  };
  try {
    const body = { scheduleId: String(schedule._id) };
    const responses = await Promise.all([
      api("/send-reminder", { body, headers }),
      api("/send-reminder", { body, headers }),
    ]);
    assert.equal(snapshots, 2);
    assert.equal(sends.length, 1);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 207]);
  } finally {
    deliveries.find = originalFind;
  }
});

