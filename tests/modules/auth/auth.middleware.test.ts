// Direct unit tests for the native src/app/modules/auth/auth.middleware.ts
// guards. Unlike verifyToken (exercised end-to-end via the change-password
// route in tests/architecture/auth-module-parity.contract.test.ts),
// verifyAdmin/verifyStaff have NO route consumer anywhere in Stage 7's five
// mounted Auth routes (confirmed by reading auth.route.ts -- only
// change-password uses middleware.verifyToken) -- they exist for future
// modules to consume once migrated. The only way to test them at all right
// now is to call createAuthMiddleware() directly and invoke the returned
// functions against a fake req/res, which is what this file does.
//
// This deliberately uses a minimal fake AuthService (only the one method the
// middleware actually calls, checkAccountState) rather than a real
// AuthRepository-backed AuthService -- AuthService's own checkAccountState
// behavior is already covered by tests/modules/auth/auth.service.test.ts;
// this file is only about the middleware's own branching (token extraction,
// status-code mapping, role allow-lists, and -- most importantly -- that the
// live DB role from checkAccountState always wins over the token's role).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import { createAuthMiddleware } from "../../../src/app/modules/auth/auth.middleware";
import type { AuthService } from "../../../src/app/modules/auth/auth.service";
import type { AuthAccountState } from "../../../src/app/modules/auth/auth.types";

const JWT_SECRET = "test-only-secret";

function fakeAuthService(stateResult: AuthAccountState): AuthService {
  return {
    checkAccountState: async () => stateResult,
  } as unknown as AuthService;
}

function signedToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET);
}

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

// verifyAdmin/verifyStaff are NOT async in auth.middleware.ts -- they call
// verifyToken(req, res, callback) without awaiting it (same shape as the
// legacy middleware/auth.js functions, see
// auth-middleware-extended.contract.test.ts's identical helper). Awaiting
// their own return value does not wait for the inner async chain to settle,
// so every call here goes through a promise that resolves only once next()
// or res.json() actually fires.
type Middleware = (req: Request, res: Response, next: () => void) => unknown;

function runMiddleware(middleware: Middleware, req: FakeRequest, res: FakeResponse): Promise<{ nextCalled: boolean }> {
  return new Promise((resolve) => {
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const result = originalJson(body);
      resolve({ nextCalled: false });
      return result;
    };
    middleware(req as unknown as Request, res as unknown as Response, () => resolve({ nextCalled: true }));
  });
}

describe("native auth.middleware.ts verifyAdmin (direct unit)", () => {
  it("role=admin -> next() called", async () => {
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true, role: "admin" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role: "admin" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });

  it("role=user -> 403 Forbidden: admins only", async () => {
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true, role: "user" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  });

  it("role missing (no live role override, token itself has no role claim) -> 403 Forbidden: admins only", async () => {
    // checkAccountState's real skip-path returns bare {ok:true} (no role key)
    // when userId is missing/invalid -- req.user then falls back to the raw
    // decoded token, which also has no role claim here.
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ email: "a@b.test" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  });
});

describe("native auth.middleware.ts verifyStaff (direct unit)", () => {
  for (const role of ["admin", "bdm", "teacher"]) {
    it(`role=${role} -> next() called`, async () => {
      const { verifyStaff } = createAuthMiddleware(fakeAuthService({ ok: true, role }), JWT_SECRET);
      const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role }) } };
      const res = fakeRes();
      const { nextCalled } = await runMiddleware(verifyStaff, req, res);
      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, undefined);
    });
  }

  it("role=user -> 403 Forbidden: staff only", async () => {
    const { verifyStaff } = createAuthMiddleware(fakeAuthService({ ok: true, role: "user" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyStaff, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: staff only" });
  });

  it("role missing -> 403 Forbidden: staff only", async () => {
    const { verifyStaff } = createAuthMiddleware(fakeAuthService({ ok: true }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ email: "a@b.test" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyStaff, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: staff only" });
  });
});

describe("native auth.middleware.ts live-role precedence (security property)", () => {
  it("token role=admin, live DB role=user -> verifyAdmin denies (403)", async () => {
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true, role: "user" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role: "admin" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admins only" });
  });

  it("token role=user, live DB role=admin -> verifyAdmin allows (next())", async () => {
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true, role: "admin" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: signedToken({ userId: "u1", role: "user" }) } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
    assert.equal(req.user?.role, "admin");
  });
});

describe("native auth.middleware.ts: authentication failures stay authentication failures through the role guards", () => {
  it("verifyAdmin + no token -> 401 NO_TOKEN (never a misleading 403)", async () => {
    const { verifyAdmin } = createAuthMiddleware(fakeAuthService({ ok: true, role: "admin" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: {} };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyAdmin, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: "Unauthorized", code: "NO_TOKEN" });
  });

  it("verifyStaff + invalid token -> 401 INVALID_TOKEN (never a misleading 403)", async () => {
    const { verifyStaff } = createAuthMiddleware(fakeAuthService({ ok: true, role: "admin" }), JWT_SECRET);
    const req: FakeRequest = { headers: {}, cookies: { token: "not-a-real-token" } };
    const res = fakeRes();
    const { nextCalled } = await runMiddleware(verifyStaff, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: "Invalid token", code: "INVALID_TOKEN" });
  });
});
