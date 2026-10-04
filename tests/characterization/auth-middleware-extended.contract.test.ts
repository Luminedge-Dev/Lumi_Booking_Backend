// Expands tests/characterization/auth-boundary.contract.test.ts, which only
// covered 5 of middleware/auth.js's real cases (NO_TOKEN/INVALID_TOKEN/
// ACCOUNT_NOT_FOUND/ACCOUNT_BLOCKED-via-isDeleted/TOKEN_STALE). This file
// locks the remaining legacy behavior directly against the middleware
// functions themselves (not through a full app + supertest), since several
// of these cases (cookie-vs-Bearer precedence, live-role override, the
// missing/invalid-userId skip-path) are about what req.user ends up
// containing, not just an HTTP status -- easiest to assert precisely by
// calling the middleware directly with a minimal fake req/res/next.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

process.env.JWT_SECRET = "test-only-secret";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { initAuth, verifyToken, verifyAdmin, verifyStaff } = require("../../middleware/auth");

interface FakeRequest {
  headers: Record<string, string>;
  cookies: Record<string, string>;
  user?: Record<string, unknown>;
}

interface FakeResponse {
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function signedToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string);
}

function expiredToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: -10 });
}

function stubCollection(findOneImpl: (filter: unknown, options?: unknown) => Promise<unknown>) {
  return { findOne: findOneImpl };
}

type LegacyMiddleware = (req: FakeRequest, res: FakeResponse, next: () => void) => unknown;

// verifyAdmin/verifyStaff are NOT `async` in middleware/auth.js -- they call
// verifyToken(req, res, callback) without awaiting it, so awaiting their own
// return value does not wait for the inner async chain to settle. This
// drives every middleware call through a promise that resolves only once
// next() or res.json() actually fires, regardless of which legacy function
// (verifyToken/verifyAdmin/verifyStaff) is under test.
function runMiddleware(middleware: LegacyMiddleware, req: FakeRequest, res: FakeResponse): Promise<{ nextCalled: boolean }> {
  return new Promise((resolve) => {
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const result = originalJson(body);
      resolve({ nextCalled: false });
      return result;
    };
    middleware(req, res, () => resolve({ nextCalled: true }));
  });
}

describe("middleware/auth.js verifyToken (characterization, direct)", () => {
  it("expired token -> 401 TOKEN_EXPIRED", async () => {
    initAuth(stubCollection(async () => {
      throw new Error("Unexpected database access for an expired token");
    }));
    const req: FakeRequest = { headers: {}, cookies: { token: expiredToken({ userId: new ObjectId().toHexString() }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: "Token expired", code: "TOKEN_EXPIRED" });
  });

  it("valid token, status=\"blocked\" (not isDeleted) -> 401 ACCOUNT_BLOCKED", async () => {
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "blocked", role: "user" })));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString() }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: "Session no longer valid", code: "ACCOUNT_BLOCKED" });
  });

  it("token with missing userId -> account-state check is SKIPPED (ok:true), next() called", async () => {
    initAuth(stubCollection(async () => {
      throw new Error("checkAccountState must not query the database when userId is absent");
    }));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ email: "a@b.test", role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
    assert.equal(req.user?.role, "user");
  });

  it("token with invalid (non-ObjectId) userId -> account-state check is SKIPPED (ok:true), next() called", async () => {
    initAuth(stubCollection(async () => {
      throw new Error("checkAccountState must not query the database for an invalid ObjectId");
    }));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "not-a-valid-object-id", role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });

  it("live role differs from token role -> live role wins in req.user", async () => {
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role: "admin" })));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString(), role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, true);
    assert.equal(req.user?.role, "admin");
  });

  it("cookie token + Bearer token both set -> cookie takes precedence", async () => {
    const cookieUserId = new ObjectId();
    const bearerUserId = new ObjectId();
    initAuth(
      stubCollection(async (filter: unknown) => {
        const id = (filter as { _id: ObjectId })._id.toHexString();
        if (id === cookieUserId.toHexString()) {
          return { _id: cookieUserId, isDeleted: false, status: "active", role: "user" };
        }
        throw new Error("Bearer token's userId should never be looked up when a cookie token is present");
      })
    );
    const req: FakeRequest = {
      headers: { authorization: `Bearer ${signedToken({ userId: bearerUserId.toHexString(), role: "admin" })}` },
      cookies: { token: signedToken({ userId: cookieUserId.toHexString(), role: "user" }) },
    };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyToken, req, res);
    assert.equal(nextCalled, true);
    assert.equal(req.user?.role, "user");
  });
});

describe("middleware/auth.js verifyAdmin (characterization, direct)", () => {
  it("role=admin -> next() called", async () => {
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role: "admin" })));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString(), role: "admin" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });

  it("role!=admin -> 403 Forbidden: admins only", async () => {
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role: "user" })));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString(), role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  });
});

describe("middleware/auth.js verifyStaff (characterization, direct)", () => {
  for (const role of ["admin", "bdm", "teacher"]) {
    it(`role=${role} -> next() called`, async () => {
      const userId = new ObjectId();
      initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role })));
      const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString(), role }) } };
      const res = fakeRes();
      const { nextCalled } = await runMiddleware(verifyStaff, req, res);
      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, undefined);
    });
  }

  it("role=user -> 403 Forbidden: staff only", async () => {
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role: "user" })));
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: userId.toHexString(), role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyStaff, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: staff only" });
  });
});

describe("scripts/mint-service-token.js compatibility (characterization, direct)", () => {
  it("a long-lived {email,userId,role} service token is still accepted by verifyStaff unchanged", async () => {
    // Mirrors scripts/mint-service-token.js exactly: same payload shape
    // ({email,userId,role}), same JWT_SECRET, just a long expiresIn instead
    // of a human session length. Stage 7's native middleware must keep
    // accepting this unchanged (AGENTS.md: never execute/modify that script).
    const userId = new ObjectId();
    initAuth(stubCollection(async () => ({ _id: userId, isDeleted: false, status: "active", role: "admin" })));
    const serviceToken = jwt.sign(
      { email: "service@luminedge.test", userId: userId.toHexString(), role: "admin" },
      process.env.JWT_SECRET as string,
      { expiresIn: "365d" }
    );
    const req: FakeRequest = { headers: { authorization: `Bearer ${serviceToken}` }, cookies: {} };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyStaff, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });
});
