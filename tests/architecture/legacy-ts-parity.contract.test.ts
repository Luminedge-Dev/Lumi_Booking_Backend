// Stage 12.5 differential parity harness (12.5.14): equivalent requests
// against the legacy composition root (app.js) and the TS candidate
// (src/app.ts) with isolated equivalent fixtures.
//
// Every mismatch is categorized, never silently normalized:
//   PARITY ONLY            -> status + body must be identical (modulo the
//                             documented nondeterministic fields below)
//   EXPECTED SECURITY      -> approved D-028 / Stage 12.5 hardening
//   EXPECTED NEW           -> approved Stage 9 monthly endpoint
//   EXPECTED OBSERVABILITY -> approved Stage 5.5 request-id/timing
//
// Ignored (nondeterministic by design): `timestamp` in GET /,
// `x-request-id` response header (candidate-only by design).
//
// Fake collections only: never Mongo, never .env, never email, never cron.
// process.env.JWT_SECRET is set because BOTH stacks verify real JWTs --
// legacy middleware/auth.js reads it directly, the native module receives
// the same value via fakeAuthConfig().
import { describe, it } from "node:test";
import {
  courseRecordFromMongoDoc,
  FakeCourseRepository,
  FakeScheduleRepository,
  fakeCoreRepositories,
  scheduleRecordFromMongoDoc,
} from "../helpers/fake-core-repositories";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp as createCandidateApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeUsersCollection } from "../helpers/fake-users-collection";
import { usersBackedRepositories } from "../helpers/fake-users-repositories";
import { FakeSchedulesCollection, type FakeScheduleDoc } from "../helpers/fake-schedules-collection";

process.env.JWT_SECRET = "test-only-secret";

// Same require-cache-busting list as
// tests/transactions/helpers/fresh-legacy-app.ts: every routes/*.routes.js
// file reuses a module-level Router() singleton, so each fresh app.js
// require must re-run every route factory to avoid duplicate handlers.
const SINGLETON_MODULES = [
  "../../app",
  "../../routes/auth.routes",
  "../../routes/user.routes",
  "../../routes/booking.routes",
  "../../routes/feedback.routes",
  "../../routes/stats.routes",
  "../../routes/schedule.routes",
  "../../middleware/auth",
  "../../middleware/rateLimit",
];

function fakeAuthConfig(): AuthConfig {
  return {
    jwtSecret: "test-only-secret",
    jwtResetPasswordSecret: "test-only-reset-secret",
    jwtExpiresIn: "7d",
    jwtResetPasswordTokenExpiresIn: "15m",
    resetPasswordLink: "https://example.test/reset-password",
    isProduction: false,
  };
}

const PARITY_COURSE = new ObjectId().toHexString();

// A Mongo schedule document carrying exactly the modeled (Stage 13) fields.
function modeledScheduleDoc(courseId: string): FakeScheduleDoc {
  return {
    _id: new ObjectId(),
    courseId,
    startDate: "2026-10-05",
    endDate: "2026-10-05",
    name: "IELTS",
    testSystem: "",
    testType: "Computer-Based",
    status: "Scheduled",
    timeSlots: [{ startTime: "09:00:00", endTime: "10:00:00", slot: 10, totalSlot: 10, slotId: "1" }],
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  } as FakeScheduleDoc;
}

interface Seed {
  users: Array<{ _id: ObjectId; email: string; password: string; role: string }>;
  schedules: FakeScheduleDoc[];
  courses: Array<Record<string, unknown>>;
}

function buildLegacy(seed: Seed) {
  for (const mod of SINGLETON_MODULES) {
    delete require.cache[require.resolve(mod)];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createLegacyApp = require("../../app");
  return createLegacyApp({
    usersCollection: new FakeUsersCollection(seed.users.map((u) => ({ ...u }))),
    coursesCollection: { find: () => ({ toArray: async () => seed.courses.map((c) => ({ ...c })) }) },
    schedulesCollection: new FakeSchedulesCollection(seed.schedules.map((s) => ({ ...s }))),
    bookingMockCollection: throwingCollection("bookingMockCollection"),
    client: {},
  });
}

// What the Stage 14 ETL would have loaded into PostgreSQL for this seed.
function candidateRepositories(seed: Seed, users: FakeUsersCollection) {
  return fakeCoreRepositories({
    ...usersBackedRepositories(users),
    course: new FakeCourseRepository(seed.courses.map(courseRecordFromMongoDoc)),
    schedule: new FakeScheduleRepository(seed.schedules.map(scheduleRecordFromMongoDoc)),
  });
}

function buildCandidate(seed: Seed) {
  const users = new FakeUsersCollection(seed.users.map((u) => ({ ...u })));
  const dependencies: AppDependencies = {
    usersCollection: users as unknown as Collection<Document>,
    coursesCollection: {
      find: () => ({ toArray: async () => seed.courses.map((c) => ({ ...c })) }),
    } as unknown as Collection<Document>,
    schedulesCollection: new FakeSchedulesCollection(
      seed.schedules.map((s) => ({ ...s }))
    ) as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createCandidateApp(dependencies, {
    corsOrigins: ["http://localhost:3000"],
    trustProxyHops: 1,
    authConfig: fakeAuthConfig(), repositories: candidateRepositories(seed, users),
  });
}

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}-${new ObjectId().toHexString()}@example.test`, password: "x", role };
}

function scrub(value: unknown): unknown {
  // Recursively normalizes nondeterministic-by-design fields: GET /'s
  // top-level `timestamp`, and per-row `createdAt`/`timestamp` stamps that
  // legitimately differ by milliseconds between two separate app runs.
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "timestamp" || key === "createdAt" ? "<scrubbed>" : scrub(entry);
    }
    return out;
  }
  return value;
}

describe("legacy-vs-TS differential parity (Stage 12.5 harness)", () => {
  it("PARITY ONLY: GET / returns identical status and message", async () => {
    const seed: Seed = { users: [], schedules: [], courses: [] };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/"),
      request(buildCandidate(seed)).get("/"),
    ]);
    assert.equal(legacyRes.status, 200);
    assert.equal(candidateRes.status, 200);
    assert.deepEqual(scrub(candidateRes.body), scrub(legacyRes.body));
  });

  it("PARITY ONLY: unknown route returns identical JSON 404", async () => {
    const seed: Seed = { users: [], schedules: [], courses: [] };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/api/v1/no-such-route"),
      request(buildCandidate(seed)).get("/api/v1/no-such-route"),
    ]);
    assert.deepEqual([legacyRes.status, legacyRes.body], [404, { message: "Not found" }]);
    assert.deepEqual([candidateRes.status, candidateRes.body], [404, { message: "Not found" }]);
  });

  it("PARITY ONLY: unknown browser origin is rejected identically", async () => {
    const seed: Seed = { users: [], schedules: [], courses: [] };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/").set("Origin", "https://evil.test"),
      request(buildCandidate(seed)).get("/").set("Origin", "https://evil.test"),
    ]);
    assert.deepEqual([legacyRes.status, legacyRes.body], [403, { message: "Origin not allowed" }]);
    assert.deepEqual([candidateRes.status, candidateRes.body], [403, { message: "Origin not allowed" }]);
  });

  it("PARITY ONLY: GET /courses returns identical bodies", async () => {
    const seed: Seed = {
      users: [],
      schedules: [],
      courses: [{ _id: new ObjectId(), name: "IELTS", image: "ielts.png", homeBasedSystems: ["windows"] }],
    };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/api/v1/courses"),
      request(buildCandidate(seed)).get("/api/v1/courses"),
    ]);
    assert.equal(legacyRes.status, 200);
    assert.equal(candidateRes.status, 200);
    assert.deepEqual(candidateRes.body, legacyRes.body);
  });

  it("EXPECTED INTENTIONAL (Stage 15): GET /courses drops unmodeled legacy fields and defaults homeBasedSystems to []", async () => {
    const seed: Seed = {
      users: [],
      schedules: [],
      courses: [{ _id: new ObjectId(), name: "IELTS", image: "ielts.png", testSystem: "Academic" }],
    };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/api/v1/courses"),
      request(buildCandidate(seed)).get("/api/v1/courses"),
    ]);
    assert.equal(legacyRes.body.courses[0].testSystem, "Academic");
    assert.ok(!("homeBasedSystems" in legacyRes.body.courses[0]));
    assert.ok(!("testSystem" in candidateRes.body.courses[0]));
    assert.deepEqual(candidateRes.body.courses[0].homeBasedSystems, []);
  });

  it("PARITY ONLY: POST /admin/create-schedule returns identical bodies", async () => {
    const admin = makeUser("admin");
    const seed: Seed = { users: [admin], schedules: [], courses: [] };
    const payload = [
      { courseId: PARITY_COURSE, startDate: "2026-10-05", endDate: "2026-10-05", testType: "Computer-Based", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] },
    ];
    const token = signToken(admin._id, "admin");
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).post("/api/v1/admin/create-schedule").set("Authorization", `Bearer ${token}`).send(payload),
      request(buildCandidate(seed)).post("/api/v1/admin/create-schedule").set("Authorization", `Bearer ${token}`).send(payload),
    ]);
    assert.equal(legacyRes.status, 201);
    assert.equal(candidateRes.status, 201);
    assert.deepEqual(scrub(candidateRes.body), scrub(legacyRes.body));
  });

  it("EXPECTED INTENTIONAL (Stage 15): create-schedule rejects an entry PostgreSQL cannot store (legacy persisted it)", async () => {
    const admin = makeUser("admin");
    const seed: Seed = { users: [admin], schedules: [], courses: [] };
    const payload = [{ courseId: "c1", startDate: "2026-10-05", endDate: "2026-10-05", timeSlots: [{ startTime: "09:00", endTime: "10:00" }] }];
    const token = signToken(admin._id, "admin");
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).post("/api/v1/admin/create-schedule").set("Authorization", `Bearer ${token}`).send(payload),
      request(buildCandidate(seed)).post("/api/v1/admin/create-schedule").set("Authorization", `Bearer ${token}`).send(payload),
    ]);
    assert.equal(legacyRes.status, 201);
    assert.equal(candidateRes.status, 409);
    assert.equal(candidateRes.body.failedSchedules[0].message, "courseId must be a valid course id");
  });

  it("PARITY ONLY: GET /schedule/:date/:courseId returns identical bodies", async () => {
    const user = makeUser();
    const seed: Seed = {
      users: [user],
      schedules: [modeledScheduleDoc(PARITY_COURSE)],      courses: [],
    };
    const token = signToken(user._id);
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get(`/api/v1/schedule/2026-10-05/${PARITY_COURSE}`).set("Authorization", `Bearer ${token}`),
      request(buildCandidate(seed)).get(`/api/v1/schedule/2026-10-05/${PARITY_COURSE}`).set("Authorization", `Bearer ${token}`),
    ]);
    assert.equal(legacyRes.status, 200);
    assert.equal(candidateRes.status, 200);
    assert.deepEqual(candidateRes.body, legacyRes.body);
  });

  it("EXPECTED NEW: monthly schedule endpoint lives only in the candidate (legacy degenerately matches it as a daily read)", async () => {
    const user = makeUser();
    const courseId = new ObjectId().toHexString();
    const seed: Seed = {
      users: [user],
      schedules: [modeledScheduleDoc(courseId)],      courses: [],
    };
    const token = signToken(user._id);
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${token}`),
      request(buildCandidate(seed)).get(`/api/v1/schedule/course/${courseId}?month=2026-10`).set("Authorization", `Bearer ${token}`),
    ]);
    // Legacy has no monthly route: this path falls into its daily-read
    // GET /schedule/:date/:courseId with date="course", which can never
    // match a real startDate -- always a degenerate empty 200. The
    // candidate serves the real monthly contract. No client could have
    // depended on the legacy answer (it is empty by construction).
    assert.equal(legacyRes.status, 200);
    assert.deepEqual(legacyRes.body, { schedules: [] });
    assert.equal(candidateRes.status, 200);
    assert.equal(candidateRes.body.schedules.length, 1);
    assert.equal(candidateRes.body.schedules[0].courseId, courseId);
  });

  it("EXPECTED SECURITY: cross-user /schedule/:userId read is open in legacy, forbidden in candidate", async () => {
    const user = makeUser();
    const other = makeUser();
    const seed: Seed = { users: [user, other], schedules: [], courses: [] };
    const token = signToken(user._id);
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get(`/api/v1/schedule/${other._id.toString()}`).set("Authorization", `Bearer ${token}`),
      request(buildCandidate(seed)).get(`/api/v1/schedule/${other._id.toString()}`).set("Authorization", `Bearer ${token}`),
    ]);
    assert.equal(legacyRes.status, 200);
    assert.equal(candidateRes.status, 403);
    assert.deepEqual(candidateRes.body, { message: "Forbidden" });
  });

  it("EXPECTED SECURITY: cross-user /user/status/:userId read is open in legacy, forbidden in candidate (D-028)", async () => {
    const user = makeUser();
    const other = makeUser();
    const seed: Seed = { users: [user, other], schedules: [], courses: [] };
    const token = signToken(user._id);
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get(`/api/v1/user/status/${other._id.toString()}`).set("Authorization", `Bearer ${token}`),
      request(buildCandidate(seed)).get(`/api/v1/user/status/${other._id.toString()}`).set("Authorization", `Bearer ${token}`),
    ]);
    assert.equal(legacyRes.status, 200);
    assert.equal(candidateRes.status, 403);
    assert.deepEqual(candidateRes.body, { message: "Forbidden" });
  });

  it("EXPECTED OBSERVABILITY: candidate stamps x-request-id, legacy does not", async () => {
    const seed: Seed = { users: [], schedules: [], courses: [] };
    const [legacyRes, candidateRes] = await Promise.all([
      request(buildLegacy(seed)).get("/"),
      request(buildCandidate(seed)).get("/"),
    ]);
    assert.equal(legacyRes.headers["x-request-id"], undefined);
    assert.ok(typeof candidateRes.headers["x-request-id"] === "string" && candidateRes.headers["x-request-id"].length > 0);
  });
});
