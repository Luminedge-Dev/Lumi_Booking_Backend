"use strict";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.CRON_SECRET = crypto.randomBytes(32).toString("hex");
process.env.PUBLIC_API_URL = "http://127.0.0.1:5000";
delete process.env.CORS_ORIGINS;
delete process.env.FRONTEND_URL_LOCAL;
delete process.env.FRONTEND_URL;

const emailModule = require("../../emailSender");

let dispatchedEmails = [];
let smtpShouldFail = false;

// Mock bulk email sender BEFORE requiring app.js (so destructured import captures the mock)
const originalBulk = emailModule.emailSenderBulk;
emailModule.emailSenderBulk = async (items) => {
  if (smtpShouldFail) {
    const errMsg = typeof smtpShouldFail === "string" ? smtpShouldFail : "Simulated SMTP error";
    return items.map(() => ({ success: false, error: new Error(errMsg) }));
  }
  for (const item of items) {
    dispatchedEmails.push(item);
  }
  return items.map(() => ({ success: true }));
};

const createApp = require("../../app");
const reminderDelivery = require("../../utils/reminderDelivery");

let server;
let baseUrl;

// In-memory data store
let memoryUsers = [];
let memorySchedules = [];
let memoryBookings = [];
let memoryDeliveries = [];

const createMemoryCollection = (name, dataRef) => ({
  name,
  find: (query = {}) => ({
    toArray: async () => {
      let filtered = [...dataRef];
      if (query._id) {
        if (query._id.$in) {
          const idSet = new Set(query._id.$in.map(String));
          filtered = filtered.filter((d) => idSet.has(String(d._id)));
        } else {
          filtered = filtered.filter((d) => String(d._id) === String(query._id));
        }
      }
      if (query.scheduleId) {
        filtered = filtered.filter((d) => String(d.scheduleId) === String(query.scheduleId));
      }
      if (query.userId) {
        if (query.userId.$in) {
          const idSet = new Set(query.userId.$in.map(String));
          filtered = filtered.filter((d) => idSet.has(String(d.userId)));
        } else {
          filtered = filtered.filter((d) => String(d.userId) === String(query.userId));
        }
      }
      if (query.status && query.status.$in) {
        const sSet = new Set(query.status.$in);
        filtered = filtered.filter((d) => sSet.has(d.status));
      }
      if (query.status && typeof query.status === "string") {
        filtered = filtered.filter((d) => d.status === query.status);
      }
      if (query.status && query.status.$ne) {
        filtered = filtered.filter((d) => d.status !== query.status.$ne);
      }
      return filtered;
    },
  }),
  findOne: async (query = {}) => {
    let filtered = [...dataRef];
    if (query._id) {
      filtered = filtered.filter((d) => String(d._id) === String(query._id));
    }
    if (query.scheduleId) {
      filtered = filtered.filter((d) => String(d.scheduleId) === String(query.scheduleId));
    }
    if (query.userId) {
      filtered = filtered.filter((d) => String(d.userId) === String(query.userId));
    }
    if (query.status && query.status.$ne) {
      filtered = filtered.filter((d) => d.status !== query.status.$ne);
    }
    return filtered[0] || null;
  },
  listIndexes: () => ({
    toArray: async () => [
      { v: 2, key: { _id: 1 }, name: "_id_" },
      { v: 2, key: { scheduleId: 1, userId: 1 }, name: "uniq_reminder_schedule_user", unique: true, sparse: false },
    ],
  }),
  countDocuments: async (query = {}) => {
    let filtered = [...dataRef];
    if (query._id && query._id.$in) {
      const idSet = new Set(query._id.$in.map(String));
      filtered = filtered.filter((d) => idSet.has(String(d._id)));
    }
    if (query.scheduleId) {
      filtered = filtered.filter((d) => String(d.scheduleId) === String(query.scheduleId));
    }
    if (query.status && query.status.$ne) {
      filtered = filtered.filter((d) => d.status !== query.status.$ne);
    }
    return filtered.length;
  },
  insertOne: async (doc) => {
    // Unique compound index enforcement on reminderDeliveries
    if (name === "reminderDeliveries") {
      const existing = dataRef.find(
        (d) => String(d.scheduleId) === String(doc.scheduleId) && String(d.userId) === String(doc.userId)
      );
      if (existing) {
        const err = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
    }
    const inserted = { _id: doc._id || new ObjectId(), ...doc };
    dataRef.push(inserted);
    return { insertedId: inserted._id };
  },
  updateOne: async (filter, update) => {
    const item = dataRef.find((d) => {
      if (filter._id && String(d._id) !== String(filter._id)) return false;
      if (filter.status && d.status !== filter.status) return false;
      return true;
    });
    if (!item) return { modifiedCount: 0 };
    if (update.$set) Object.assign(item, update.$set);
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) delete item[k];
    }
    return { modifiedCount: 1 };
  },
  updateMany: async (filter, update) => {
    let count = 0;
    for (const item of dataRef) {
      let match = true;
      if (filter.scheduleId && String(item.scheduleId) !== String(filter.scheduleId)) match = false;
      if (filter.status && item.status !== filter.status) match = false;
      if (match) {
        if (update.$set) Object.assign(item, update.$set);
        count++;
      }
    }
    return { modifiedCount: count };
  },
  findOneAndUpdate: async (filter, update) => {
    const item = dataRef.find((d) => {
      if (filter._id && String(d._id) !== String(filter._id)) return false;
      if (filter.status && d.status !== filter.status) return false;
      if (filter.jobId && d.jobId !== filter.jobId) return false;
      return true;
    });
    if (!item) return null;
    if (update.$set) Object.assign(item, update.$set);
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        item[k] = (item[k] || 0) + v;
      }
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) delete item[k];
    }
    return item;
  },
  deleteOne: async (filter) => {
    const idx = dataRef.findIndex((d) => String(d._id) === String(filter._id));
    if (idx >= 0) {
      dataRef.splice(idx, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  },
  aggregate: () => ({ toArray: async () => [] }),
});

let adminUser;

function adminToken() {
  return jwt.sign(
    { userId: String(adminUser._id), role: "admin", email: adminUser.email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function userToken(user) {
  return jwt.sign(
    { userId: String(user._id), role: "user", email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

before(async () => {
  adminUser = {
    _id: new ObjectId(),
    name: "System Admin",
    email: "admin@luminedge.com",
    role: "admin",
    status: "completed",
    isDeleted: false,
  };

  const usersCollection = createMemoryCollection("users", memoryUsers);
  const schedulesCollection = createMemoryCollection("schedules", memorySchedules);
  const coursesCollection = createMemoryCollection("courses", []);
  const bookingMockCollection = createMemoryCollection("bookingMock", memoryBookings);
  const reminderDeliveriesCollection = createMemoryCollection("reminderDeliveries", memoryDeliveries);

  const app = createApp({
    usersCollection,
    schedulesCollection,
    coursesCollection,
    bookingMockCollection,
    reminderDeliveriesCollection,
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  emailModule.emailSenderBulk = originalBulk;
});

beforeEach(() => {
  dispatchedEmails = [];
  smtpShouldFail = false;
  memoryUsers.length = 0;
  memorySchedules.length = 0;
  memoryBookings.length = 0;
  memoryDeliveries.length = 0;
  memoryUsers.push(adminUser);
});

test("E2E-01: Admin sends reminder for eligible Test Center booking -> sent: 1, mock SMTP accepts", async () => {
  const scheduleId = new ObjectId();
  const studentId = new ObjectId();
  const bookingId = new ObjectId();

  const schedule = {
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"), // 10:00 AM Asia/Dhaka
    timeSlots: [{ slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" }],
  };
  memorySchedules.push(schedule);

  const student = {
    _id: studentId,
    name: "Rahim Ahmed",
    email: "rahim.ahmed@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  };
  memoryUsers.push(student);

  const booking = {
    _id: bookingId,
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-1",
    startTime: "10:00",
    endTime: "13:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "active",
  };
  memoryBookings.push(booking);

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  const data = await res.json();
  if (res.status !== 200) console.log("E2E-01 res body:", data);
  assert.equal(res.status, 200);
  assert.equal(data.sent, 1);
  assert.equal(data.alreadyAccepted, 0);
  assert.equal(data.failed, 0);

  // Check email content
  assert.equal(dispatchedEmails.length, 1);
  assert.equal(dispatchedEmails[0].to, "rahim.ahmed@example.com");
  assert.ok(dispatchedEmails[0].content.includes("Rahim Ahmed"));
  assert.ok(dispatchedEmails[0].content.includes("10:00–13:00 (Dhaka time)"));
  assert.ok(dispatchedEmails[0].content.includes("Test Center"));

  // Check ledger record
  assert.equal(memoryDeliveries.length, 1);
  assert.equal(memoryDeliveries[0].status, "accepted");
  assert.equal(String(memoryDeliveries[0].scheduleId), scheduleId.toHexString());
  assert.equal(String(memoryDeliveries[0].userId), studentId.toHexString());
});

test("E2E-02: Triggering reminder a second time deduplicates -> alreadyAccepted: 1, sent: 0", async () => {
  const scheduleId = new ObjectId();
  const studentId = new ObjectId();

  memorySchedules.push({
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"),
    timeSlots: [{ slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" }],
  });

  memoryUsers.push({
    _id: studentId,
    name: "Rahim Ahmed",
    email: "rahim.ahmed@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  });

  memoryBookings.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-1",
    startTime: "10:00",
    endTime: "13:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "active",
  });

  // Pre-populate ledger with accepted record from earlier send
  memoryDeliveries.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    status: "accepted",
    outcome: "accepted",
    updatedAt: new Date(),
  });

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  const data = await res.json();
  if (res.status !== 200) console.log("E2E-01 res body:", data);
  assert.equal(res.status, 200);
  assert.equal(data.sent, 0);
  assert.equal(data.alreadyAccepted, 1);
  assert.equal(dispatchedEmails.length, 0, "No duplicate email should be dispatched");
});

test("E2E-03: Canceled bookings are excluded from reminder recipients", async () => {
  const scheduleId = new ObjectId();
  const studentId = new ObjectId();

  memorySchedules.push({
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"),
    timeSlots: [{ slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" }],
  });

  memoryUsers.push({
    _id: studentId,
    name: "Karim Uddin",
    email: "karim.uddin@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  });

  memoryBookings.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-1",
    startTime: "10:00",
    endTime: "13:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "cancelled", // CANCELED
  });

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  const data = await res.json();
  if (res.status !== 200) console.log("E2E-01 res body:", data);
  assert.equal(res.status, 200);
  assert.equal(data.sent, 0);
  assert.equal(dispatchedEmails.length, 0, "Canceled booking must not receive a reminder");
});

test("E2E-04: Student with invalid email is skipped and accounted under invalidRecipients", async () => {
  const scheduleId = new ObjectId();
  const studentId = new ObjectId();

  memorySchedules.push({
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"),
    timeSlots: [{ slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" }],
  });

  memoryUsers.push({
    _id: studentId,
    name: "No Email Student",
    email: "not-an-email-address", // INVALID EMAIL
    role: "user",
    status: "completed",
    isDeleted: false,
  });

  memoryBookings.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-1",
    startTime: "10:00",
    endTime: "13:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "active",
  });

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  const data = await res.json();
  if (res.status !== 200) console.log("E2E-01 res body:", data);
  assert.equal(res.status, 200);
  assert.equal(data.sent, 0);
  assert.equal(data.invalidRecipients, 1);
  assert.equal(dispatchedEmails.length, 0);
});

test("E2E-05: Rescheduled booking reflects the updated slot time", async () => {
  const scheduleId = new ObjectId();
  const studentId = new ObjectId();

  memorySchedules.push({
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"),
    timeSlots: [
      { slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" },
      { slotId: "slot-tc-2", startTime: "14:00", endTime: "17:00" }, // Rescheduled target
    ],
  });

  memoryUsers.push({
    _id: studentId,
    name: "Anika Tabassum",
    email: "anika@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  });

  memoryBookings.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-2", // Rescheduled slot
    startTime: "14:00",
    endTime: "17:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "active",
  });

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  assert.equal(res.status, 200);
  assert.equal(dispatchedEmails.length, 1);
  assert.ok(dispatchedEmails[0].content.includes("14:00–17:00 (Dhaka time)"), "Email must contain rescheduled time");
});

test("E2E-06: SMTP not configured marks delivery as failed and returns 502", async () => {
  smtpShouldFail = "SMTP is not configured";

  const scheduleId = new ObjectId();
  const studentId = new ObjectId();

  memorySchedules.push({
    _id: scheduleId,
    name: "IELTS Mock Examination",
    testType: "Academic",
    testSystem: "IELTS",
    startDate: new Date("2026-11-20T04:00:00Z"),
    timeSlots: [{ slotId: "slot-tc-1", startTime: "10:00", endTime: "13:00" }],
  });

  memoryUsers.push({
    _id: studentId,
    name: "Sajib Sen",
    email: "sajib@example.com",
    role: "user",
    status: "completed",
    isDeleted: false,
  });

  memoryBookings.push({
    _id: new ObjectId(),
    scheduleId: scheduleId.toHexString(),
    userId: studentId.toHexString(),
    slotId: "slot-tc-1",
    startTime: "10:00",
    endTime: "13:00",
    location: "Test Center",
    testType: "Academic",
    testSystem: "IELTS",
    bookingDate: new Date("2026-11-20T04:00:00Z"),
    status: "active",
  });

  const res = await fetch(`${baseUrl}/api/v1/send-reminder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify({ scheduleId: scheduleId.toHexString() }),
  });

  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.failed, 1);
  assert.equal(memoryDeliveries[0].status, "failed");
});
