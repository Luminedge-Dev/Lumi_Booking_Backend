"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const reminder = require("../../utils/reminderDelivery");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const bookingRoutes = read("routes/booking.routes.js");
const authRoutes = read("routes/auth.routes.js");
const userRoutes = read("routes/user.routes.js");

test("booking confirmation uses approved office contact details and retains dynamic sanitization", () => {
  assert.match(bookingRoutes, /Office Address: 42 Satmasjid Road, Dhanmondi\./);
  assert.match(bookingRoutes, /01400-403485/);
  assert.doesNotMatch(bookingRoutes, /01400-406374|743 Satmasjid|Dhanmondi 9\/A/);
  assert.match(bookingRoutes, /const safe = \(v\) => sanitizeHtml\(String\(v \|\| ""\)/);
  assert.match(bookingRoutes, /Test Location: \$\{safe\(bookingRecord\.location\)\}/);
});

test("registration and user verification emails use the approved support number", () => {
  assert.match(authRoutes, /01400-403485/);
  assert.doesNotMatch(authRoutes, /01400-406374|743 Satmasjid/);
  assert.match(userRoutes, /01400-403485/);
  assert.doesNotMatch(userRoutes, /01400-406374|743 Satmasjid/);
  // This separate, unverified support line is intentionally retained.
  assert.match(userRoutes, /01400-403474/);
});

test("FIX-05 reminder template renders approved support contact without inventing a venue", () => {
  const result = reminder.buildReminderEmail({
    user: { name: "<Student>" },
    schedule: { name: "IELTS <script>", startDate: "2030-04-05" },
    booking: { testType: "Academic", location: "Home" },
    slot: { startTime: "09:00:00", endTime: "12:00:00" },
  });
  assert.match(result.message, /01400-403485/);
  assert.match(result.message, /Venue: Home/);
  assert.match(result.message, /&lt;Student&gt;/);
  assert.match(result.message, /&lt;script&gt;/);
  assert.doesNotMatch(result.message, /01400-406374|743 Satmasjid|Gawsia Twin Peak/);
});
