import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { startServer, type ServerHandle } from "../../src/server";
import { resetEnvCacheForTests } from "../../src/app/config/env";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "./helpers/stage13-target";
import { Stage16Fixtures, prefixedId, STAGE16B_PREFIX, STAGE16B_EMAIL_DOMAIN } from "./helpers/stage16-fixtures";

const PORT = 5872;
const KEYS = ["MONGODB_URI", "PORT", "CORS_ORIGINS", "JWT_SECRET", "JWT_RESET_PASS_SECRET", "SMTP_HOST", "EMAIL", "APP_PASS", "VERCEL"] as const;
const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
const results: Record<string, unknown> = {};
let counter = 60_000;
const nextId = () => prefixedId(STAGE16B_PREFIX, counter++);

describe("Stage 16B boot smoke (real server, ephemeral Mongo + stage13-dev PostgreSQL)", { timeout: 600_000 }, () => {
  let mongo: TransactionTestDb;
  let handle: ServerHandle;
  let fixtures: Stage16Fixtures;
  const base = `http://127.0.0.1:${PORT}/api/v1`;

  before(async () => {
    assertStage13Target();
    mongo = await startTransactionTestDb();
    process.env.MONGODB_URI = mongo.replSet.getUri();
    process.env.PORT = String(PORT);
    process.env.CORS_ORIGINS = "http://localhost:3000";
    process.env.JWT_SECRET = "boot-smoke-secret";
    process.env.JWT_RESET_PASS_SECRET = "boot-smoke-reset-secret";
    delete process.env.SMTP_HOST;
    delete process.env.EMAIL;
    delete process.env.APP_PASS;
    process.env.VERCEL = "1";
    resetEnvCacheForTests();
    fixtures = new Stage16Fixtures(getPrismaClient(), STAGE16B_PREFIX);
    await fixtures.assertNamespaceEmpty("boot smoke before");
    handle = await startServer();
  });

  after(async () => {
    try {
      await handle?.close();
      await fixtures?.cleanup();
      await fixtures?.assertNamespaceEmpty("boot smoke after");
    } finally {
      await disconnectPrisma();
      await mongo?.teardown();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCacheForTests();
      console.log("STAGE16B_BOOT_SMOKE " + JSON.stringify(results));
    }
  });

  const http = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it("admin grant, CI email collision 409, and block are visible through the real server", async () => {
    const prisma = getPrismaClient();
    const adminId = fixtures.trackUser(nextId());
    const ownerId = fixtures.trackUser(nextId());
    const targetId = fixtures.trackUser(nextId());
    await prisma.user.createMany({
      data: [
        { id: adminId, name: "Admin", email: `${adminId}@${STAGE16B_EMAIL_DOMAIN}`, password: "x", role: "admin", status: "active" },
        { id: ownerId, name: "Owner", email: `Member@${STAGE16B_EMAIL_DOMAIN}`, password: "x", role: "user", status: "active" },
        { id: targetId, name: "Target", email: `${targetId}@${STAGE16B_EMAIL_DOMAIN}`, password: "x", role: "user", status: "active", mock: 0, totalMock: 0 },
      ],
    });
    const adminTok = jwt.sign({ userId: adminId, email: `${adminId}@${STAGE16B_EMAIL_DOMAIN}`, role: "admin" }, "boot-smoke-secret");
    const userTok = jwt.sign({ userId: targetId, email: `${targetId}@${STAGE16B_EMAIL_DOMAIN}`, role: "user" }, "boot-smoke-secret");

    const granted = await http("PUT", `/user/update-multiple/${targetId}`, adminTok, {
      mocks: [{ mock: 1, transactionId: "MR-SMOKE", mockType: "IELTS" }],
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: targetId } })).mock, 1);

    const clash = await http("PUT", `/user/approve-profile-edit/${targetId}`, adminTok, {
      email: `member@${STAGE16B_EMAIL_DOMAIN}`,
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.message, "Email address already in use");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: targetId } })).email, `${targetId}@${STAGE16B_EMAIL_DOMAIN}`);

    const blocked = await http("PUT", `/user/block/${targetId}`, adminTok, { isDeleted: true });
    assert.equal(blocked.status, 200);
    const denied = await http("GET", `/user/${targetId}`, userTok);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, "ACCOUNT_BLOCKED");
    results.grantCollisionBlockOk = true;
  });
});
