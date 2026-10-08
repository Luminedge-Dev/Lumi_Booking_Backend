import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Application } from "express";
import { createApp } from "../../src/app";
import { createCoreRepositories } from "../../src/app/runtime/core-repositories";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import type { AuthConfig } from "../../src/app/modules/auth/auth.types";
import type { UserNotifier } from "../../src/app/modules/user/user.service";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { freshLegacyTransactionApp } from "../transactions/helpers/fresh-legacy-app";
import { applyTestEnv, restoreTestEnv } from "../transactions/helpers/jwt";
import { assertStage13Target } from "../postgres/helpers/stage13-target";
import { Stage16Fixtures, prefixedId, STAGE16B_PREFIX, STAGE16B_EMAIL_DOMAIN } from "../postgres/helpers/stage16-fixtures";
import { assertParity, type IntentionalDifference } from "./helpers/compare";

const authConfig: AuthConfig = {
  jwtSecret: "test-only-secret",
  jwtResetPasswordSecret: "test-only-reset-secret",
  jwtExpiresIn: "7d",
  jwtResetPasswordTokenExpiresIn: "15m",
  resetPasswordLink: "https://example.test/reset-password",
  isProduction: false,
};
const silentNotifier: UserNotifier = { mocksGranted() {}, accountCompleted() {} };

type Role = "user" | "admin";
interface Actor {
  id: string;
  role: Role;
}
interface Wire {
  status: number;
  body: Record<string, unknown>;
}

let counter = 40_000;
const nextId = () => prefixedId(STAGE16B_PREFIX, counter++);

function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "createdAt" || k === "updatedAt" || k === "mrValidationExpiry" ? "<ts>" : mask(v)])
    );
  }
  return value;
}

describe("Stage 16B parity: admin PUTs (legacy Mongo vs PostgreSQL native)", { timeout: 1_800_000 }, () => {
  let mongo: TransactionTestDb;
  let legacy: Application;
  let native: Application;
  let fixtures: Stage16Fixtures;

  before(async () => {
    assertStage13Target();
    applyTestEnv();
    mongo = await startTransactionTestDb();
    legacy = freshLegacyTransactionApp(mongo.collections, mongo.client);
    native = createApp(
      { ...mongo.collections, client: mongo.client },
      {
        corsOrigins: ["http://localhost:3000"],
        trustProxyHops: 1,
        authConfig,
        repositories: createCoreRepositories(),
        userNotifier: silentNotifier,
      }
    );
    fixtures = new Stage16Fixtures(getPrismaClient(), STAGE16B_PREFIX);
    await fixtures.assertNamespaceEmpty("parity before");
  });

  after(async () => {
    try {
      await fixtures?.cleanup();
      await fixtures?.assertNamespaceEmpty("parity after");
    } finally {
      await disconnectPrisma();
      await mongo?.teardown();
      restoreTestEnv();
    }
  });

  const token = (actor: Actor) =>
    jwt.sign({ userId: actor.id, email: `${actor.id}@${STAGE16B_EMAIL_DOMAIN}`, role: actor.role }, "test-only-secret");

  async function seedUser(role: Role, extra: Record<string, unknown> = {}): Promise<Actor> {
    const id = fixtures.trackUser(nextId());
    const doc = {
      _id: new ObjectId(id),
      name: "Parity User",
      email: `${id}@${STAGE16B_EMAIL_DOMAIN}`,
      password: "x",
      role,
      mock: 0,
      totalMock: 0,
      status: "active",
      isDeleted: false,
      mocks: [],
      ...extra,
    };
    await mongo.collections.usersCollection.insertOne(doc as never);
    const { _id, mocks, ...pg } = doc as typeof doc & { mocks?: unknown };
    await getPrismaClient().user.create({
      data: {
        id,
        name: pg.name,
        email: pg.email,
        password: pg.password,
        role: pg.role as "user" | "admin",
        mock: Number(pg.mock),
        totalMock: Number(pg.totalMock),
        status: (pg.status as "active") ?? "active",
        isDeleted: Boolean(pg.isDeleted),
      },
    });
    if (Array.isArray(mocks)) {
      for (const entry of mocks as Array<Record<string, unknown>>) {
        await getPrismaClient().mockAllocation.create({
          data: {
            userId: id,
            transactionId: typeof entry.transactionId === "string" ? entry.transactionId : null,
            mock: typeof entry.mock === "number" ? entry.mock : null,
          },
        });
      }
    }
    return { id, role };
  }

  async function call(app: Application, method: "put", path: string, actor: Actor, body?: unknown): Promise<Wire> {
    let req = request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${token(actor)}`);
    const res = body === undefined ? await req : await req.send(body as object);
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  async function both(path: string, actor: Actor, body: unknown) {
    return {
      m: await call(legacy, "put", path, actor, body),
      p: await call(native, "put", path, actor, body),
    };
  }

  const expectParity = (r: { m: Wire; p: Wire }, differences: IntentionalDifference[], label: string) =>
    assertParity({ status: r.m.status, body: mask(r.m.body) }, { status: r.p.status, body: mask(r.p.body) }, differences, label);

  it("grant, status, block, unique adjust, and non-colliding approve match", async () => {
    const admin = await seedUser("admin");
    const user = await seedUser("user", { mock: 1, totalMock: 1 });
    const grant = await both(`/user/update-multiple/${user.id}`, admin, {
      mocks: [{ mock: 2, transactionId: "MR-P", mockType: "IELTS", testType: "Computer-Based", mrValidation: "6 months" }],
    });
    expectParity(grant, [], "grant");
    assert.equal(grant.p.status, 200);

    const status = await both(`/user/status/${user.id}`, admin, { status: "checked" });
    expectParity(status, [], "status");

    const blocked = await both(`/user/block/${user.id}`, admin, { isDeleted: true });
    expectParity(blocked, [], "block");
    const unblocked = await both(`/user/block/${user.id}`, admin, { isDeleted: false });
    expectParity(unblocked, [], "unblock");

    const unique = await seedUser("user", { mock: 2, totalMock: 2, mocks: [{ transactionId: "MR-U", mock: 2 }] });
    const adjust = await both(`/user/update-one/${unique.id}`, admin, {
      transactionId: "MR-U",
      updatedMock: { mock: 1, mrValidation: "1 day" },
    });
    expectParity(adjust, [], "adjust unique");

    const approve = await both(`/user/approve-profile-edit/${user.id}`, admin, { name: "Renamed" });
    expectParity(approve, [], "approve name");
  });

  it("P1 email collision and D9 ambiguous txnId are declared differences (409 vs legacy mutation)", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("user", { email: `OwnerMix@${STAGE16B_EMAIL_DOMAIN}` });
    const target = await seedUser("user");
    const clash = await both(`/user/approve-profile-edit/${target.id}`, admin, {
      email: `ownermix@${STAGE16B_EMAIL_DOMAIN}`,
    });
    assertParity(
      { status: clash.m.status, message: clash.m.body.message },
      { status: clash.p.status, message: clash.p.body.message },
      [
        {
          path: "status",
          mongo: 200,
          postgres: 409,
          reason: "P1: native refuses a case-insensitive email collision; legacy overwrote it",
        },
        {
          path: "message",
          mongo: "User profile updated by admin",
          postgres: "Email address already in use",
          reason: "P1 409 body",
        },
      ],
      "P1 collision"
    );
    void owner;

    const ambiguous = await seedUser("user", {
      mock: 4,
      totalMock: 4,
      mocks: [
        { transactionId: "MR-1", mock: 2 },
        { transactionId: " MR-1 ", mock: 2 },
      ],
    });
    const d9 = await both(`/user/update-one/${ambiguous.id}`, admin, {
      transactionId: "MR-1",
      updatedMock: { mock: 1, mrValidation: "1 day" },
    });
    assertParity(
      { status: d9.m.status, message: d9.m.body.message },
      { status: d9.p.status, message: d9.p.body.message },
      [
        {
          path: "status",
          mongo: 200,
          postgres: 409,
          reason: "D9: native refuses ambiguous trimmed transaction IDs; legacy updated the first match",
        },
        {
          path: "message",
          mongo: "Mock updated successfully",
          postgres: "Ambiguous transaction ID",
          reason: "D9 409 body",
        },
      ],
      "D9 ambiguous"
    );
  });
});
