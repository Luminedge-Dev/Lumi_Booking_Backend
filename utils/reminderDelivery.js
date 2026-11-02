"use strict";

const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const MAX_CONTINUATION_DEPTH = 20;
const CONTINUATION_TTL_MS = 15 * 60 * 1000;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const CONTINUATION_PURPOSE = "luminedge-reminder-continuation-v1";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const validEmail = (value) => EMAIL_PATTERN.test(normalizeEmail(value));

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "Asia/Dhaka" }).format(value);
  }
  const text = String(value == null ? "" : value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 6));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return "";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "Asia/Dhaka" }).format(date);
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "Asia/Dhaka" }).format(date)
    : "";
}

function buildReminderEmail({ user, schedule, booking, slot }) {
  const date = formatDate(schedule.startDate || booking.bookingDate);
  const startTime = String(slot.startTime || "").trim();
  const endTime = String(slot.endTime || "").trim();
  if (!date || !startTime || !endTime) throw new Error("Reminder details are incomplete.");
  const title = [schedule.name, schedule.testType || booking.testType, schedule.testSystem || booking.testSystem]
    .map((part) => String(part || "").trim()).filter(Boolean).join(" — ");
  const venue = String(booking.location || "").trim();
  const subject = `Mock test reminder: ${date}`;
  const message = `<div><p>Dear ${escapeHtml(user.name || "Student")},</p>
<p>This is a reminder that your mock test is scheduled for <strong>${escapeHtml(date)}</strong>.</p>
<h3>Test details</h3><ul><li>Test: ${escapeHtml(title || "Mock test")}</li>
<li>Date: ${escapeHtml(date)}</li><li>Time: ${escapeHtml(startTime)}–${escapeHtml(endTime)} (Dhaka time)</li>
<li>Venue: ${escapeHtml(venue || "As arranged")}</li></ul>
<h3>Reporting instructions</h3><ul><li>Please arrive 30 minutes before your test time.</li>
<li>Bring a valid photo ID (Passport/NID) matching your account information.</li>
<li>Bring your own stationery items.</li></ul><p>For assistance, contact Luminedge at 01400-403485.</p><p>Best regards,<br>The Luminedge Team</p></div>`;
  return { subject, message };
}

function normalizeUserIds(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values.map((value) => String(value == null ? "" : value).trim()).filter(Boolean))];
}

function validSlotTime(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value == null ? "" : value).trim());
  if (!match) return false;
  const [, hour, minute, second = "00"] = match;
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function bookingSlot(schedule, booking) {
  const slots = Array.isArray(schedule.timeSlots) ? schedule.timeSlots : [];
  const slotId = String(booking.slotId == null ? "" : booking.slotId).trim();
  if (!slotId) return null;
  const matches = slots.filter((slot) => String(slot.slotId == null ? "" : slot.slotId).trim() === slotId);
  if (matches.length !== 1) return null;
  const slot = matches[0];
  if (!validSlotTime(slot.startTime) || !validSlotTime(slot.endTime)) return null;
  if (booking.startTime && String(booking.startTime).trim() !== String(slot.startTime).trim()) return null;
  if (booking.endTime && String(booking.endTime).trim() !== String(slot.endTime).trim()) return null;
  return slot;
}

function signContinuation(payload, secret) {
  if (!secret) throw new Error("Continuation secret is not configured.");
  const body = Buffer.from(JSON.stringify({ purpose: CONTINUATION_PURPOSE, ...payload })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyContinuation(token, secret, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.purpose !== CONTINUATION_PURPOSE || typeof payload.scheduleId !== "string" ||
        typeof payload.jobId !== "string" || !Number.isInteger(payload.depth) ||
        payload.depth < 1 || payload.depth > MAX_CONTINUATION_DEPTH ||
        !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch { return null; }
}

async function hasRequiredUniqueIndex(collection) {
  if (!collection || typeof collection.listIndexes !== "function") return false;
  try {
    const indexes = await collection.listIndexes().toArray();
    return indexes.some((index) => {
      if (!index || index.unique !== true || index.sparse === true ||
          Object.prototype.hasOwnProperty.call(index, "partialFilterExpression")) return false;
      const entries = Object.entries(index.key || {});
      return entries.length === 2 && entries[0][0] === "scheduleId" && entries[0][1] === 1 &&
        entries[1][0] === "userId" && entries[1][1] === 1;
    });
  } catch { return false; }
}

function isValidScheduleId(value) {
  return typeof value === "string" && ObjectId.isValid(value) && String(new ObjectId(value)) === value.toLowerCase();
}

function configuredPublicApiUrl(raw, environment = process.env.NODE_ENV) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) return null;
    if (environment === "production" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

module.exports = {
  MAX_CONTINUATION_DEPTH,
  CONTINUATION_TTL_MS,
  PROCESSING_LEASE_MS,
  normalizeEmail,
  validEmail,
  escapeHtml,
  formatDate,
  buildReminderEmail,
  normalizeUserIds,
  validSlotTime,
  bookingSlot,
  signContinuation,
  verifyContinuation,
  hasRequiredUniqueIndex,
  isValidScheduleId,
  configuredPublicApiUrl,
};
