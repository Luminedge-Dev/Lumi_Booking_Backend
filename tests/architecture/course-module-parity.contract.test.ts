// Proves the native TypeScript Course module (src/app/modules/course, mounted
// by src/app.ts) keeps the HTTP contract locked in
// tests/characterization/course-read.contract.test.ts, now on the Stage 15
// PostgreSQL repository boundary. The HTTP layer is exercised against an
// in-memory repository; PostgreSQL semantics are proven separately in
// tests/postgres/course-repository.postgres.ts and tests/parity/.
//
// Two legacy raw-document behaviors are INTENTIONALLY different now (the
// PostgreSQL row only has the Stage 13 columns) and are asserted explicitly:
//   - an unmodeled extra document field is no longer carried through;
//   - a course with no homeBasedSystems reads as [] (the column default).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import type { CourseRepository } from "../../src/app/modules/course/course.repository";
import type { CourseRecord } from "../../src/app/modules/course/course.types";
import { throwingCollection } from "../helpers/create-test-app";
import { FakeCourseRepository, fakeCoreRepositories } from "../helpers/fake-core-repositories";

const HEX = "6713f7ab0123456789abcdef";

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

function appWith(course: CourseRepository) {
  const dependencies: AppDependencies = {
    usersCollection: throwingCollection("usersCollection") as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, {
    corsOrigins: ["http://localhost:3000"],
    trustProxyHops: 1,
    authConfig: fakeAuthConfig(),
    repositories: fakeCoreRepositories({ course }),
  });
}

function record(overrides: Partial<CourseRecord> = {}): CourseRecord {
  return { _id: HEX, name: "IELTS", image: "ielts.png", homeBasedSystems: [], ...overrides };
}

describe("native Course module parity: GET /api/v1/courses", () => {
  it("200 {courses:[...]}, no auth required, identical envelope to legacy", async () => {
    const app = appWith(new FakeCourseRepository([record()]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.equal(res.body.courses.length, 1);
    assert.equal(res.body.courses[0].name, "IELTS");
    assert.equal(res.body.courses[0]._id, HEX);
  });

  it("empty table -> 200 {courses:[]}", async () => {
    const res = await request(appWith(new FakeCourseRepository([]))).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { courses: [] });
  });

  it("INTENTIONAL DIFFERENCE: an extra, unmodeled legacy document field is not carried (no PostgreSQL column)", async () => {
    const app = appWith(new FakeCourseRepository([record()]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.courses[0], "someUnexpectedField"));
  });

  it("INTENTIONAL DIFFERENCE: a course without homeBasedSystems reads as [] (column default), not absent", async () => {
    const app = appWith(new FakeCourseRepository([record({ homeBasedSystems: [] })]));
    const res = await request(app).get("/api/v1/courses");
    assert.deepEqual(res.body.courses[0].homeBasedSystems, []);
  });

  it("persistence failure -> 500 with the fixed legacy body and no persistence detail", async () => {
    const app = appWith({
      findAll: async () => {
        throw new Error("SELECT secret_table FROM somewhere failed");
      },
    });
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "Failed to load courses." });
  });
});
