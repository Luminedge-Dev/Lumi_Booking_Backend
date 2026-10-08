// Stage 16 (D-039): Booking + Home teacher assignment persistence boundary.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => (l.indexOf("//") === -1 ? l : l.slice(0, l.indexOf("//")))).join("\n");
const moduleDir = path.join(root, "src/app/modules/booking");
const moduleFiles = fs.readdirSync(moduleDir).filter((f) => f.endsWith(".ts"));

describe("Stage 16 booking module boundary (architecture)", () => {
  it("only booking.repository.ts touches Prisma, raw SQL or the Mongo driver", () => {
    for (const file of moduleFiles) {
      const code = stripComments(fs.readFileSync(path.join(moduleDir, file), "utf8"));
      if (file === "booking.repository.ts") continue;
      assert.doesNotMatch(code, /generated\/prisma|@prisma\/|database\/prisma"|\$queryRaw|\$executeRaw|\$transaction|PrismaClient/, file);
      assert.doesNotMatch(code, /from "mongodb"|require\(/, file);
      assert.doesNotMatch(code, /Collection\b/, file);
    }
  });

  it("services do not depend on Express; controllers do not touch persistence", () => {
    assert.doesNotMatch(stripComments(read("src/app/modules/booking/booking.service.ts")), /from "express"|\breq\b|\bres\b/);
    const controller = stripComments(read("src/app/modules/booking/booking.controller.ts"));
    assert.doesNotMatch(controller, /repository|prisma|\$queryRaw/i);
  });

  it("runtime code never imports from scripts/", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(root, "src")).filter((f) => f.endsWith(".ts") && !f.includes(`${path.sep}generated${path.sep}`))) {
      assert.doesNotMatch(stripComments(fs.readFileSync(file, "utf8")), /from "(\.\.\/)+scripts\//, file);
    }
  });

  it("every credit and seat mutation is guarded and its affected-row count is checked", () => {
    const code = stripComments(read("src/app/modules/booking/booking.repository.ts"));
    assert.match(code, /UPDATE users SET mock = mock - 1 WHERE id = \$\{command\.userId\} AND mock > 0/);
    assert.match(code, /UPDATE schedule_slots SET seats_left = seats_left - 1[\s\S]*?AND seats_left > 0/);
    assert.match(code, /if \(seat !== 1\) return \{ kind: "slot_taken" \}/);
    assert.match(code, /if \(credit !== 1\)/);
    assert.match(code, /if \(deleted !== 1\) return \{ kind: "not_found" \}/);
    // The restore only runs after the delete removed exactly one row.
    assert.ok(code.indexOf("deleted !== 1") < code.indexOf("seats_left = seats_left + 1"));
    assert.ok(code.indexOf("seats_left = seats_left + 1") < code.indexOf("mock = mock + 1"));
    // No unguarded decrement anywhere.
    assert.doesNotMatch(code, /mock = mock - 1 WHERE id = \$\{[^}]+\}`/);
  });

  it("canonical lock order is users -> schedule_slots -> bookings -> writes in every transaction", () => {
    const code = stripComments(read("src/app/modules/booking/booking.repository.ts"));
    const slice = (start: string, end: string) => code.slice(code.indexOf(start), code.indexOf(end));
    const tc = slice("async createTestCenterBooking", "async cancelBooking");
    assert.ok(tc.indexOf("FROM users WHERE id") < tc.indexOf("UPDATE schedule_slots"));
    assert.ok(tc.indexOf("UPDATE schedule_slots") < tc.indexOf("UPDATE users SET mock = mock - 1"));
    assert.ok(tc.indexOf("UPDATE users SET mock = mock - 1") < tc.indexOf("tx.booking.create"));
    const cancel = slice("async cancelBooking", "async assignTeacher");
    assert.ok(cancel.indexOf("FROM users WHERE id") < cancel.indexOf("FROM schedule_slots WHERE"));
    assert.ok(cancel.indexOf("FROM schedule_slots WHERE") < cancel.indexOf("FROM bookings WHERE id"));
    assert.ok(cancel.indexOf("FROM bookings WHERE id") < cancel.indexOf("DELETE FROM bookings"));
    const assign = slice("async assignTeacher", "// ---- reads");
    assert.ok(assign.indexOf("FROM users WHERE id") < assign.indexOf("FROM bookings WHERE id"));
    assert.ok(assign.indexOf("FROM bookings WHERE id") < assign.indexOf("teacherAssignment.upsert"));
    assert.ok(assign.indexOf("teacherAssignment.upsert") < assign.indexOf("tx.booking.update"));
  });

  it("transactions go through the Stage 13 Serializable helper with bounded settings", () => {
    const code = read("src/app/modules/booking/booking.repository.ts");
    assert.match(code, /runSerializableTransaction/);
    assert.match(code, /BOOKING_TRANSACTION = \{ maxAttempts: 5, backoffMs: 25, maxWaitMs: 10000, timeoutMs: 15000 \}/);
    assert.doesNotMatch(code, /\$transaction\(/);
  });

  it("no Mongo fallback: the booking repository never imports the Mongo driver or collections", () => {
    const code = stripComments(read("src/app/modules/booking/booking.repository.ts"));
    assert.doesNotMatch(code, /mongodb|bookingMockCollection|usersCollection/);
  });

  it("native booking is mounted before the shadowed legacy booking router, which is mounted exactly once (after native Auth)", () => {
    const code = stripComments(read("src/app/router/index.ts"));
    const auth = code.indexOf("router.use(authModule.router)");
    const native = code.indexOf("router.use(bookingModule.router)");
    const legacy = code.indexOf("mountLegacyBookingRoutes(router, legacyDeps)");
    assert.ok(auth > -1 && native > auth && legacy > native, "auth -> native booking -> legacy booking");
    assert.equal(code.split("mountLegacyBookingRoutes(router").length - 1, 1);
    assert.ok(legacy < code.indexOf("router.use(userModule.router)"));
    // Native booking uses the PostgreSQL-backed auth middleware.
    assert.match(code, /createBookingModule\(\{[\s\S]*?authMiddleware: authModule\.middleware/);
  });

  it("native route table covers every migrated booking path and leaves /send-reminder to legacy", () => {
    const code = stripComments(read("src/app/modules/booking/booking.route.ts"));
    for (const p of ["/user/book-slot", "/user/attendance/bulk", "/user/bookings/:userId", "/user/bookings/:scheduleId", "/admin/bookings/home-with-users", "/admin/bookings/by-schedule/:scheduleId", "/admin/bookings\"", "/admin/bookings/:bookingId/teacher", "/bookings/:bookingId"]) {
      assert.ok(code.includes(p), p);
    }
    assert.doesNotMatch(code, /send-reminder/);
    assert.match(read("routes/booking.routes.js"), /\/send-reminder/);
  });

  it("e-mail templates live only in the compat layer and are invoked from the service, after the repository call", () => {
    const service = stripComments(read("src/app/modules/booking/booking.service.ts"));
    assert.ok(service.indexOf("await this.repository.createHomeBooking") < service.indexOf("this.notifier.bookingConfirmed"));
    assert.ok(service.indexOf("await this.repository.updateAttendance") < service.indexOf("this.notifier.attendanceRecorded"));
    assert.doesNotMatch(service, /emailSender|waitUntil/);
    assert.match(read("src/app/compat/legacy-email.ts"), /legacyBookingNotifier/);
  });

  it("the legacy teacher-assignment route remains in feedback.routes.js (rollback) but is shadowed by the native route", () => {
    assert.match(read("routes/feedback.routes.js"), /\/admin\/bookings\/:bookingId\/teacher/);
    const router = stripComments(read("src/app/router/index.ts"));
    assert.ok(router.indexOf("router.use(bookingModule.router)") < router.indexOf("mountLegacyUserAndMidRoutes(router"));
  });

  it("legacy source files are untouched in behavior: routes/booking.routes.js and routes/feedback.routes.js still require the legacy auth", () => {
    assert.match(read("routes/booking.routes.js"), /require\("\.\.\/middleware\/auth"\)/);
  });
});
