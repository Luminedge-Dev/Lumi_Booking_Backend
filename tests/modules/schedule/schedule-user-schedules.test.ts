// Stage 12.5 MIGRATE + SECURE proof for GET /schedule/:userId (D-033
// runtime-cutover blocker closure). Legacy served this verifyToken-only --
// any authenticated caller could read any user's schedules. Native serves
// it self-or-approved-staff, preserving the exact read shape ({schedules},
// 500 {message:"Failed to load schedules."}).
//
// Fake collections/repositories only: never Mongo/PostgreSQL, never .env, never email, never cron.
// Stage 15: schedules live in PostgreSQL, which has no schedule.userId; the
// real repository returns [] (proven in tests/postgres). Here a stub
// repository returns marker rows so authorization gating is observable.
// process.env.JWT_SECRET is set because the native Auth boundary is real;
// the fake users collection backs its live account-state reload.
import { describe, it } from "node:test";
import { FakeScheduleRepository, fakeCoreRepositories, scheduleRecord } from "../../helpers/fake-core-repositories";
import { usersBackedRepositories } from "../../helpers/fake-users-repositories";
import type { ScheduleRecord } from "../../../src/app/modules/schedule/schedule.types";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document, MongoClient } from "mongodb";
import { createApp } from "../../../src/app";
import type { AppDependencies } from "../../../src/app/database/database.types";
import type { AuthConfig } from "../../../src/app/modules/auth/auth.types";
import { throwingCollection } from "../../helpers/create-test-app";
import { FakeUsersCollection } from "../../helpers/fake-users-collection";

process.env.JWT_SECRET = "test-only-secret";

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

class UserScheduleStub extends FakeScheduleRepository {
  readonly calls: string[] = [];
  constructor(private readonly byUser: Record<string, ScheduleRecord[]> = {}) {
    super();
  }
  async findByUserId(userId: string): Promise<ScheduleRecord[]> {
    this.calls.push(userId);
    return this.byUser[userId] ?? [];
  }
}

function appWith(usersCollection: FakeUsersCollection, schedules: FakeScheduleRepository) {
  const dependencies: AppDependencies = {
    usersCollection: usersCollection as unknown as Collection<Document>,
    coursesCollection: throwingCollection("coursesCollection") as unknown as Collection<Document>,
    schedulesCollection: throwingCollection("schedulesCollection") as unknown as Collection<Document>,
    bookingMockCollection: throwingCollection("bookingMockCollection") as unknown as Collection<Document>,
    client: {} as MongoClient,
  };
  return createApp(dependencies, { corsOrigins: ["http://localhost:3000"], trustProxyHops: 1, authConfig: fakeAuthConfig(), repositories: fakeCoreRepositories({ ...usersBackedRepositories(usersCollection), schedule: schedules }) });
}

function signToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

function makeUser(role = "user") {
  return { _id: new ObjectId(), email: `${role}-${new ObjectId().toHexString()}@example.test`, password: "x", role };
}

function markerRow(marker: string): ScheduleRecord {
  return scheduleRecord({ marker });
}

describe("GET /api/v1/schedule/:userId (native, self-or-staff)", () => {
  it("self reads own schedules only, exact legacy read shape", async () => {
    const user = makeUser();
    const other = makeUser();
    const app = appWith(
      new FakeUsersCollection([user, other]),
      new UserScheduleStub({
        [user._id.toString()]: [markerRow("mine")],
        [other._id.toString()]: [markerRow("theirs")],
      })
    );

    const res = await request(app)
      .get(`/api/v1/schedule/${user._id.toString()}`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 1);
    assert.equal(res.body.schedules[0].marker, "mine");
  });

  it("different ordinary user is forbidden, exact 403 contract", async () => {
    const user = makeUser();
    const other = makeUser();
    const stub = new UserScheduleStub({ [other._id.toString()]: [markerRow("theirs")] });
    const app = appWith(
      new FakeUsersCollection([user, other]),
      stub
    );

    const res = await request(app)
      .get(`/api/v1/schedule/${other._id.toString()}`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);

    assert.equal(res.status, 403);
    assert.deepEqual(stub.calls, [], "a forbidden request must never reach the repository");
    assert.deepEqual(res.body, { message: "Forbidden" });
  });

  for (const role of ["admin", "bdm", "teacher"]) {
    it(`${role} staff reads another user's schedules`, async () => {
      const staff = makeUser(role);
      const target = makeUser();
      const app = appWith(
        new FakeUsersCollection([staff, target]),
        new UserScheduleStub({ [target._id.toString()]: [markerRow("target-doc")] })
      );

      const res = await request(app)
        .get(`/api/v1/schedule/${target._id.toString()}`)
        .set("Authorization", `Bearer ${signToken(staff._id, role)}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.schedules.length, 1);
      assert.equal(res.body.schedules[0].marker, "target-doc");
    });
  }

  it("unauthenticated request is unauthorized (verifyToken still first)", async () => {
    const target = makeUser();
    const app = appWith(new FakeUsersCollection([target]), new FakeScheduleRepository());

    const res = await request(app).get(`/api/v1/schedule/${target._id.toString()}`);

    assert.equal(res.status, 401);
  });

  it("unknown target id returns the legacy empty shape, not 404", async () => {
    const user = makeUser("admin");
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());

    const res = await request(app)
      .get(`/api/v1/schedule/${new ObjectId().toString()}`)
      .set("Authorization", `Bearer ${signToken(user._id, "admin")}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("non-ObjectId target is still staff-readable (no new format validation on the read)", async () => {
    const staff = makeUser("admin");
    const app = appWith(new FakeUsersCollection([staff]), new FakeScheduleRepository());

    const res = await request(app)
      .get("/api/v1/schedule/some-legacy-string-id")
      .set("Authorization", `Bearer ${signToken(staff._id, "admin")}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("non-ObjectId target stays forbidden for an unrelated ordinary user", async () => {
    const user = makeUser();
    const app = appWith(new FakeUsersCollection([user]), new FakeScheduleRepository());

    const res = await request(app)
      .get("/api/v1/schedule/some-legacy-string-id")
      .set("Authorization", `Bearer ${signToken(user._id)}`);

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { message: "Forbidden" });
  });

  it("mixed-case hex self id is authorized (canonical ObjectId equality), read stays legacy raw-string match", async () => {
    const user = makeUser();
    const app = appWith(
      new FakeUsersCollection([user]),
      new UserScheduleStub({ [user._id.toString()]: [markerRow("mine")] })
    );

    const res = await request(app)
      .get(`/api/v1/schedule/${user._id.toString().toUpperCase()}`)
      .set("Authorization", `Bearer ${signToken(user._id)}`);

    // Authorization is canonical (200, not 403); the READ itself stays a
    // raw-string find({userId}) exactly like legacy, so an uppercase param
    // matches nothing stored lowercase -- identical to what legacy returns
    // for the same input string.
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
  });

  it("persistence failure keeps the exact legacy 500 contract", async () => {
    const user = makeUser("admin");
    class FailingRepository extends FakeScheduleRepository {
      async findByUserId(): Promise<never> {
        throw new Error("simulated failure");
      }
    }
    const app = appWith(new FakeUsersCollection([user]), new FailingRepository());
    const res = await request(app)
      .get(`/api/v1/schedule/${user._id.toString()}`)
      .set("Authorization", `Bearer ${signToken(user._id, "admin")}`);

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "Failed to load schedules." });
  });
});
