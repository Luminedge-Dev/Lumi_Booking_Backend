// Characterizes routes/schedule.routes.js:58-68's GET /courses end-to-end
// via supertest against the legacy app.js, before Stage 8's native Course
// module replaces it in the TS candidate. schedule.routes.js has the same
// Router()-singleton pattern Stage 7 found in auth.routes.js, so this file
// busts the require cache the same way.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { ObjectId } from "mongodb";
import { throwingCollection } from "../helpers/create-test-app";

function freshApp(coursesCollection: unknown) {
  for (const mod of ["../../app", "../../routes/schedule.routes"]) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createApp = require("../../app");
  return createApp({
    usersCollection: throwingCollection("usersCollection"),
    coursesCollection,
    schedulesCollection: throwingCollection("schedulesCollection"),
    bookingMockCollection: throwingCollection("bookingMockCollection"),
    client: {},
  });
}

class FakeCoursesCollection {
  constructor(private docs: Array<Record<string, unknown>> = []) {}
  find(_filter: Record<string, unknown> = {}) {
    return {
      toArray: async () => this.docs,
    };
  }
}

describe("GET /api/v1/courses (characterization)", () => {
  it("200 {courses:[...]}, no auth required", async () => {
    const app = freshApp(new FakeCoursesCollection([{ _id: new ObjectId(), name: "IELTS", image: "ielts.png", homeBasedSystems: ["windows"] }]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.equal(res.body.courses.length, 1);
    assert.equal(res.body.courses[0].name, "IELTS");
  });

  it("exact raw-document shape: an unexpected extra field survives untouched", async () => {
    const app = freshApp(
      new FakeCoursesCollection([
        { _id: new ObjectId(), name: "PTE", image: "pte.png", homeBasedSystems: [], someUnexpectedField: "legacy-value" },
      ])
    );
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.equal(res.body.courses[0].someUnexpectedField, "legacy-value");
  });

  it("missing homeBasedSystems preserved as absent, not coerced to []", async () => {
    const app = freshApp(new FakeCoursesCollection([{ _id: new ObjectId(), name: "TOEFL", image: "toefl.png" }]));
    const res = await request(app).get("/api/v1/courses");
    assert.equal(res.status, 200);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.courses[0], "homeBasedSystems"));
  });
});
