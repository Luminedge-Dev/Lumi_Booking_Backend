// Proves the native TypeScript Course module (src/app/modules/course,
// mounted by src/app.ts) matches the legacy contract locked in
// tests/characterization/course-read.contract.test.ts. course.route.ts
// calls Router() fresh inside createCourseRouter() every time, so no
// require-cache-busting is needed (same pattern as Stage 7/8's other native
// modules).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/database/database.types";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import { throwingCollection } from "../helpers/create-test-app";

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

class FakeCoursesCollection {
  constructor(private docs: Array<Record<string, unknown>> = []) {}
  find() {
    return { toArray: async () => this.docs };
  }
}

function appWith(coursesCollection: FakeCoursesCollection) {
  const dependencies: AppDependencies = {
    usersCollection: throwingCollection("usersCollection") as unknown as Collection<Document>,
    coursesCollection: coursesCollection as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, { authConfig: fakeAuthConfig() });
}

describe("native Course module parity: GET /api/v1/courses", () => {
  it("200 {courses:[...]}, no auth required, identical to legacy", async () => {
    const app = appWith(new FakeCoursesCollection([{ _id: new ObjectId(), name: "IELTS", image: "ielts.png" }]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.equal(res.body.courses[0].name, "IELTS");
  });

  it("an unexpected 7th field survives mapping untouched, identical to legacy's raw passthrough", async () => {
    const app = appWith(new FakeCoursesCollection([{ _id: new ObjectId(), name: "PTE", futureField: "value" }]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.equal(res.body.courses[0].futureField, "value");
  });

  it("missing homeBasedSystems preserved as absent, not coerced to []", async () => {
    const app = appWith(new FakeCoursesCollection([{ _id: new ObjectId(), name: "TOEFL" }]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.courses[0], "homeBasedSystems"));
  });
});
