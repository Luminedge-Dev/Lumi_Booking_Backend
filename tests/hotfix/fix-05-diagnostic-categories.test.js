"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
delete process.env.CORS_ORIGINS;
delete process.env.FRONTEND_URL_LOCAL;
delete process.env.FRONTEND_URL;

const createApp = require("../../app");
const reminderDelivery = require("../../utils/reminderDelivery");

let server;
let baseUrl;
let mockIndexes = [];
let adminUser;
let studentUser;

const validCompoundIndex = {
  v: 2,
  key: { scheduleId: 1, userId: 1 },
  name: "uniq_reminder_schedule_user",
  unique: true,
  sparse: false,
};

const stubCollection = (name) => ({
  name,
  find: () => ({ toArray: async () => [] }),
  findOne: async (query) => {
    if (name === "users" && query?._id) {
      if (String(query._id) === String(adminUser?._id)) return adminUser;
      if (String(query._id) === String(studentUser?._id)) return studentUser;
    }
    if (name === "schedules" && query?._id) {
      return { _id: query._id, name: "IELTS Mock", startDate: new Date("2026-11-20T10:00:00Z"), timeSlots: [] };
    }
    return null;
  },
  listIndexes: () => ({
    toArray: async () => mockIndexes,
  }),
  countDocuments: async () => 0,
  updateMany: async () => ({ modifiedCount: 0 }),
  insertOne: async () => ({ insertedId: new ObjectId() }),
  updateOne: async () => ({ modifiedCount: 0 }),
  deleteOne: async () => ({ deletedCount: 0 }),
  aggregate: () => ({ toArray: async () => [] }),
});

function adminToken() {
  return jwt.sign(
    { userId: String(adminUser._id), role: "admin", email: adminUser.email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function userToken() {
  return jwt.sign(
    { userId: String(studentUser._id), role: "user", email: studentUser.email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

before(async () => {
  adminUser = {
    _id: new ObjectId(),
    name: "Admin User",
    email: "admin@luminedge.com",
    role: "admin",
    status: "completed",
    isDeleted: false,
  };

  studentUser = {
    _id: new ObjectId(),
    name: "Student User",
    email: "student@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  };

  const usersCollection = stubCollection("users");
  const schedulesCollection = stubCollection("schedules");
  const coursesCollection = stubCollection("courses");
  const bookingMockCollection = stubCollection("bookingMock");
  const reminderDeliveriesCollection = stubCollection("reminderDeliveries");

  const app = createApp({
    usersCollection,
    schedulesCollection,
    coursesCollection,
    bookingMockCollection,
    reminderDeliveriesCollection,
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("M04-T01: Missing unique index returns 503 with REMINDER_INDEX_NOT_READY", async () => {
  mockIndexes = []; // No unique compound index
  process.env.PUBLIC_API_URL = "http://127.0.0.1:5000";
  process.env.CRON_SECRET = "test-secret-12345678901234567890";

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.message, "Reminder delivery is temporarily unavailable.");
  assert.equal(data.errorCategory, "REMINDER_INDEX_NOT_READY");
});

test("M04-T02: Missing PUBLIC_API_URL returns 503 with REMINDER_PUBLIC_API_URL_MISSING", async () => {
  mockIndexes = [validCompoundIndex];
  delete process.env.PUBLIC_API_URL;
  process.env.CRON_SECRET = "test-secret-12345678901234567890";

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.message, "Reminder delivery is temporarily unavailable.");
  assert.equal(data.errorCategory, "REMINDER_PUBLIC_API_URL_MISSING");
});

test("M04-T03: Malformed PUBLIC_API_URL returns 503 with REMINDER_PUBLIC_API_URL_INVALID", async () => {
  mockIndexes = [validCompoundIndex];
  process.env.PUBLIC_API_URL = "not-a-valid-url";
  process.env.CRON_SECRET = "test-secret-12345678901234567890";

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.message, "Reminder delivery is temporarily unavailable.");
  assert.equal(data.errorCategory, "REMINDER_PUBLIC_API_URL_INVALID");
});

test("M04-T04: Missing CRON_SECRET returns 503 with REMINDER_CONTINUATION_SECRET_MISSING", async () => {
  mockIndexes = [validCompoundIndex];
  process.env.PUBLIC_API_URL = "http://127.0.0.1:5000";
  delete process.env.CRON_SECRET;

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.message, "Reminder delivery is temporarily unavailable.");
  assert.equal(data.errorCategory, "REMINDER_CONTINUATION_SECRET_MISSING");
});

test("M04-T05: When PUBLIC_API_URL is missing, diagnostic reports REMINDER_PUBLIC_API_URL_MISSING", async () => {
  mockIndexes = [validCompoundIndex];
  delete process.env.PUBLIC_API_URL;
  delete process.env.CRON_SECRET;

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.message, "Reminder delivery is temporarily unavailable.");
  assert.equal(data.errorCategory, "REMINDER_PUBLIC_API_URL_MISSING");
});

test("M04-T06: Non-admin caller is rejected 403 before any 503 configuration check", async () => {
  mockIndexes = []; // Even with missing indexes, non-admin gets 403
  delete process.env.PUBLIC_API_URL;

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userToken()}`,
    },
    body: JSON.stringify({ scheduleId: new ObjectId().toHexString() }),
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.message, "Forbidden: admins only");
});

test("M06-T01: Reminder email template renders escaped content and approved contact details", () => {
  const email = reminderDelivery.buildReminderEmail({
    user: { name: "<Script & Hacker>" },
    schedule: { name: "IELTS Academic", testType: "Academic", testSystem: "IELTS", startDate: "2026-11-20" },
    booking: { location: "Test Center", testType: "Academic", testSystem: "IELTS" },
    slot: { startTime: "10:00", endTime: "13:00" },
  });

  assert.ok(email.subject.includes("Mock test reminder"));
  assert.ok(email.message.includes("&lt;Script &amp; Hacker&gt;"), "Must escape user name HTML");
  assert.ok(email.message.includes("01400-403485"), "Must include approved Luminedge support contact");
  assert.ok(email.message.includes("10:00–13:00 (Dhaka time)"), "Must include Dhaka time specification");
  assert.ok(email.message.includes("Bring a valid photo ID (Passport/NID)"), "Must include ID requirements");
});
