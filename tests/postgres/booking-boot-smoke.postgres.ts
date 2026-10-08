import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { startServer, type ServerHandle } from "../../src/server";
import { resetEnvCacheForTests } from "../../src/app/config/env";
import { disconnectPrisma, getPrismaClient } from "../../src/app/database/prisma";
import { startTransactionTestDb, type TransactionTestDb } from "../transactions/helpers/replica-set";
import { assertStage13Target } from "./helpers/stage13-target";
import { Stage16Fixtures, stage16Id, STAGE16_EMAIL_DOMAIN } from "./helpers/stage16-fixtures";

// Stage 16 boot smoke: the REAL server lifecycle (src/server.ts -> bootstrap ->
// listen) over a real socket, with a disposable in-memory MongoDB for the
// still-legacy parts and the real stage13-dev PostgreSQL for Auth/Booking.
// MONGODB_URI is overridden BEFORE config is read, so the production Mongo URI
// from .env is never used (dotenv does not override already-set variables).

const PORT = 5871;
const KEYS = ["MONGODB_URI", "PORT", "CORS_ORIGINS", "JWT_SECRET", "JWT_RESET_PASS_SECRET", "SMTP_HOST", "EMAIL", "APP_PASS", "VERCEL"] as const;
const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
const results: Record<string, unknown> = {};

describe("Stage 16 boot smoke (real server, ephemeral Mongo + stage13-dev PostgreSQL)", { timeout: 600_000 }, () => {
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
    // Serverless mode skips the in-process reminder cron (a long-lived Mongo-bound
    // job, cutover blocker B5) so the smoke process can exit cleanly.
    process.env.VERCEL = "1";
    resetEnvCacheForTests();
    fixtures = new Stage16Fixtures(getPrismaClient());
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
      console.log("BOOT_SMOKE " + JSON.stringify(results));
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

  it("serves the root and rejects anonymous booking requests", async () => {
    const root = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(root.status, 200);
    assert.equal((await http("POST", "/user/book-slot")).status, 401);
    assert.equal((await http("GET", `/user/bookings/${stage16Id(1)}`)).status, 401);
    // POST /send-reminder is still the legacy handler (Mongo-backed auth): anonymous -> 401, not a native 404.
    assert.equal((await http("POST", "/send-reminder", undefined, { emails: [] })).status, 401);
  });

  it("a PostgreSQL-only user books, lists, and cancels through the real server (no Mongo user exists)", async () => {
    const id = fixtures.trackUser(stage16Id(9500));
    await getPrismaClient().user.create({
      data: { id, name: "Smoke", email: `${id}@${STAGE16_EMAIL_DOMAIN}`, password: "x", role: "user", mock: 1, totalMock: 1, status: "active" },
    });
    assert.equal(await mongo.collections.usersCollection.countDocuments({}), 0, "ephemeral Mongo has no users");
    const token = jwt.sign({ userId: id, email: `${id}@${STAGE16_EMAIL_DOMAIN}`, role: "user" }, "boot-smoke-secret");

    const booked = await http("POST", "/user/book-slot", token, { userId: id, location: "Home", name: "IELTS", testType: "Computer-Based", testSystem: "Computer-Based", bookingDate: "2031-07-07", testTime: "09:30" });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    const bookingId = (booked.body.bookingRecord as { _id: string })._id;
    assert.match(bookingId, /^[0-9a-f]{24}$/);

    const list = await http("GET", `/user/bookings/${id}`, token);
    assert.equal(list.status, 200);
    assert.equal((list.body.bookings as unknown[]).length, 1);

    const denied = await http("GET", `/user/bookings/${stage16Id(2)}`, token);
    assert.equal(denied.status, 403);

    const noCredit = await http("POST", "/user/book-slot", token, { userId: id, location: "Home", name: "IELTS", testType: "Computer-Based", testSystem: "Computer-Based", bookingDate: "2031-07-08", testTime: "09:30" });
    assert.equal(noCredit.status, 400);
    assert.match(String(noCredit.body.message), /Insufficient mock/);

    const cancelled = await http("DELETE", `/bookings/${bookingId}`, token);
    assert.equal(cancelled.status, 200);
    assert.equal((await getPrismaClient().user.findUniqueOrThrow({ where: { id } })).mock, 1);
    assert.equal(await mongo.collections.bookingMockCollection.countDocuments({}), 0, "no Mongo booking was ever written");
    results.bookHomeCancelOk = true;
  });
});
