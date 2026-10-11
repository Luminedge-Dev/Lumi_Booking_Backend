import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { authorizeCleanupExecution } from "../../../scripts/migration/stage17/allowlist";
import { discoverNeonMetadata } from "../../../scripts/migration/stage17/neon-discovery";
import {
  NEON_API_ORIGIN,
  NEON_CREDENTIAL_POLICY,
  assertNeonReadMethod,
  assertNeonRequestPolicy,
  createNeonFetchAdapter,
  createNeonReadTransport,
  type NeonApiFetch,
  type NeonApiRequest,
  type NeonApiResponse,
} from "../../../scripts/migration/stage17/neon-api-transport";
import { parseStage17Args } from "../../../scripts/migration/stage17/cli";
import { allowsDestructiveRehearsal, STAGE13_DEV_ENDPOINT_ID } from "../../../scripts/migration/stage17/rehearsal-guard";
import { runStage17 } from "../../../scripts/migration/stage17/runner";

const BACKEND = path.resolve(__dirname, "../../../");
const TOKEN = "offline-token";
const PROJECT = "proj-test";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}, url?: string): NeonApiResponse {
  return {
    status,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function branch(id: string, name: string, parentId: string | null) {
  return { id, name, parent_id: parentId };
}

function pages(map: (request: NeonApiRequest) => NeonApiResponse): { fetchImpl: NeonApiFetch; urls: string[]; methods: string[] } {
  const urls: string[] = [];
  const methods: string[] = [];
  const fetchImpl: NeonApiFetch = async (request) => {
    urls.push(request.url.toString());
    methods.push(request.method);
    assert.equal(request.redirect, "error");
    assert.equal(request.url.origin, NEON_API_ORIGIN);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    return map(request);
  };
  return { fetchImpl, urls, methods };
}

describe("Stage 17 F2 Neon API transport", () => {
  it("reads one explicit project, paged branches, and a single endpoint list", async () => {
    const seen = pages((request) => {
      if (request.url.pathname.endsWith("/branches")) {
        const cursor = request.url.searchParams.get("cursor");
        assert.equal(request.url.searchParams.get("limit"), "1");
        if (!cursor) {
          return jsonResponse({
            branches: [branch("br-parent", "stage13-dev", null)],
            pagination: { next: "cursor-1", sort_order: "desc" },
          });
        }
        assert.equal(cursor, "cursor-1");
        return jsonResponse({ branches: [branch("br-child", "stage17-rehearsal-test", "br-parent")], pagination: { sort_order: "desc" } });
      }
      if (request.url.pathname.endsWith("/endpoints")) {
        return jsonResponse({ endpoints: [{ id: "ep-rehearsal-test", branch_id: "br-child" }, { id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-parent" }] });
      }
      assert.equal(request.url.pathname, "/api/v2/projects/proj-test");
      return jsonResponse({ project: { id: PROJECT } });
    });
    const transport = createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: seen.fetchImpl, pageLimit: 1 });
    const evidence = await discoverNeonMetadata({
      transport,
      approved: { projectId: PROJECT, parentBranchId: "br-parent", childBranchName: "stage17-rehearsal-test" },
    });
    assert.equal(evidence.writeAuthority, "none");
    assert.equal(evidence.child.status, "present");
    assert.equal(seen.methods.every((method) => method === "GET"), true);
    assert.equal(seen.urls.some((url) => url.endsWith("/api/v2/projects")), false);
    assert.equal(JSON.stringify(evidence).includes(TOKEN), false);
  });

  it("records a missing child and rejects a missing parent or the wrong project", async () => {
    const parentOnly = pages((request) => {
      if (request.url.pathname.endsWith("/branches")) return jsonResponse({ branches: [branch("br-parent", "stage13-dev", null)] });
      if (request.url.pathname.endsWith("/endpoints")) return jsonResponse({ endpoints: [{ id: STAGE13_DEV_ENDPOINT_ID, branch_id: "br-parent" }] });
      return jsonResponse({ project: { id: PROJECT } });
    });
    const absent = await discoverNeonMetadata({
      transport: createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: parentOnly.fetchImpl }),
      approved: { projectId: PROJECT, parentBranchId: "br-parent", childBranchName: "stage17-rehearsal-test" },
    });
    assert.equal(absent.child.status, "absent");
    assert.equal(absent.writeAuthority, "none");
    const noParent = pages((request) => {
      if (request.url.pathname.endsWith("/branches")) return jsonResponse({ branches: [branch("br-other", "main", null)] });
      if (request.url.pathname.endsWith("/endpoints")) return jsonResponse({ endpoints: [] });
      return jsonResponse({ project: { id: PROJECT } });
    });
    await assert.rejects(
      () => discoverNeonMetadata({ transport: createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: noParent.fetchImpl }), approved: { projectId: PROJECT } }),
      /parent branch stage13-dev is missing/,
    );
    await assert.rejects(
      () => discoverNeonMetadata({
        transport: createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: parentOnly.fetchImpl }),
        approved: { projectId: "proj-other" },
      }),
      /approved project/,
    );
  });

  it("rejects an incomplete branch collection, a repeated cursor, and a duplicate id across pages", async () => {
    let page = 0;
    const endless = pages(() => {
      page += 1;
      return jsonResponse({ branches: [branch(`br-page-${page}`, page === 1 ? "stage13-dev" : "other", null)], pagination: { next: `cursor-${page}`, sort_order: "desc" } });
    });
    await assert.rejects(
      async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: endless.fetchImpl, pageLimit: 1, maxPages: 2 }).readBranches(); },
      /branch collection is incomplete/,
    );
    let repeated = 0;
    const repeat = pages(() => {
      repeated += 1;
      return jsonResponse({ branches: [branch(`br-${repeated}`, "stage13-dev", null)], pagination: { next: "cursor-same", sort_order: "desc" } });
    });
    await assert.rejects(
      async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: repeat.fetchImpl, pageLimit: 1, maxPages: 4 }).readBranches(); },
      /pagination marker is repeated/,
    );
    let dupPage = 0;
    const duplicated = pages(() => {
      dupPage += 1;
      if (dupPage === 1) return jsonResponse({ branches: [branch("br-parent", "stage13-dev", null)], pagination: { next: "cursor-2", sort_order: "desc" } });
      return jsonResponse({ branches: [branch("br-parent", "other", null)], pagination: { sort_order: "desc" } });
    });
    await assert.rejects(
      async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: duplicated.fetchImpl, pageLimit: 1 }).readBranches(); },
      /branch id is duplicated/,
    );
    const pagedEndpoints = pages(() => jsonResponse({ endpoints: [], pagination: { next: "more" } }));
    await assert.rejects(
      async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: pagedEndpoints.fetchImpl }).readEndpoints(); },
      /outside the documented contract/,
    );
  });

  it("fails closed on an API error, a timeout, and a redirect, and redacts the credential", async () => {
    const failed = pages(() => jsonResponse({ message: TOKEN }, 500));
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: failed.fetchImpl }).readProject(); }, (error: unknown) => {
      assert.match((error as Error).message, /Neon API project request failed status 500 server error/);
      assert.equal((error as Error).message.includes(TOKEN), false);
      assert.doesNotMatch((error as Error).message, /https?:|authorization|bearer/i);
      return true;
    });
    const redirect = pages(() => jsonResponse({ ok: true }, 302, { location: "https://evil.example/collect" }));
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: redirect.fetchImpl }).readProject(); }, /unexpected redirect/);
    assert.equal(redirect.urls.length, 1);
    const slow: NeonApiFetch = (request) => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => {
        const error = new Error(`aborted ${TOKEN}`);
        error.name = "AbortError";
        reject(error);
      });
    });
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: slow, timeoutMs: 20 }).readProject(); }, (error: unknown) => {
      assert.match((error as Error).message, /Neon API project request timed out/);
      assert.equal((error as Error).message.includes(TOKEN), false);
      return true;
    });
    const leaking: NeonApiFetch = async () => {
      throw new Error(`bearer ${TOKEN} https://console.neon.tech/api/v2/projects/${PROJECT}`);
    };
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: leaking }).readProject(); }, (error: unknown) => {
      assert.match((error as Error).message, /Neon API project request failed network/);
      assert.equal((error as Error).message.includes(TOKEN), false);
      assert.doesNotMatch((error as Error).message, /https?:|authorization|bearer/i);
      return true;
    });
  });

  it("classifies HTTP failures by request label and status without a retry or a response body", async () => {
    const cases: { status: number; read: "readProject" | "readBranches" | "readEndpoints"; label: string; kind: string }[] = [
      { status: 401, read: "readProject", label: "project", kind: "credential rejected" },
      { status: 403, read: "readBranches", label: "branches", kind: "credential forbidden" },
      { status: 404, read: "readEndpoints", label: "endpoints", kind: "resource not found" },
      { status: 429, read: "readProject", label: "project", kind: "rate limited" },
      { status: 500, read: "readEndpoints", label: "endpoints", kind: "server error" },
    ];
    for (const item of cases) {
      let calls = 0;
      const fetchImpl: NeonApiFetch = async () => {
        calls += 1;
        return jsonResponse({ message: TOKEN, authorization: `Bearer ${TOKEN}` }, item.status, { "www-authenticate": `Bearer ${TOKEN}` });
      };
      await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl })[item.read](); }, (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, new RegExp(`Neon API ${item.label} request failed status ${item.status} ${item.kind}`));
        assert.equal(message.includes(TOKEN), false);
        assert.doesNotMatch(message, /https?:|authorization|bearer|www-authenticate/i);
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it("requires redirect error before the request and rejects both cross-origin and same-origin redirects", async () => {
    const seen = pages(() => jsonResponse({ project: { id: PROJECT } }));
    await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: seen.fetchImpl }).readProject();
    assert.equal(seen.urls.length, 1);
    const sameOrigin = pages(() => jsonResponse({ project: { id: PROJECT } }, 200, {}, "https://console.neon.tech/api/v2/projects/proj-other"));
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: sameOrigin.fetchImpl }).readProject(); }, /unexpected redirect/);
    const crossOrigin = pages(() => jsonResponse({ project: { id: PROJECT } }, 302, { location: "https://evil.example/collect" }));
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: crossOrigin.fetchImpl }).readProject(); }, /unexpected redirect/);
    let adapterCalls = 0;
    const adapter = createNeonFetchAdapter(async (_input, init) => {
      adapterCalls += 1;
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "GET");
      return jsonResponse({ project: { id: PROJECT } }, 200, {}, "https://console.neon.tech/api/v2/projects/proj-test");
    });
    const approved = new URL("https://console.neon.tech/api/v2/projects/proj-test");
    await adapter({ method: "GET", redirect: "error", url: approved, headers: { accept: "application/json", authorization: `Bearer ${TOKEN}` }, signal: new AbortController().signal });
    assert.equal(adapterCalls, 1);
    adapterCalls = 0;
    await assert.rejects(() => adapter({ method: "GET", redirect: "follow" as "error", url: new URL("https://evil.example/steal"), headers: { accept: "application/json", authorization: `Bearer ${TOKEN}` }, signal: new AbortController().signal }), /redirect following is not allowed/);
    assert.equal(adapterCalls, 0);
    assert.throws(() => assertNeonRequestPolicy({ method: "GET", redirect: "manual", url: approved }), /redirect following is not allowed/);
  });

  it("rejects unsafe timeouts, page bounds, and a full branch page with no pagination marker", async () => {
    const idle: NeonApiFetch = async () => jsonResponse({ project: { id: PROJECT } });
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, 60_001]) {
      assert.throws(() => createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: idle, timeoutMs }), /timeout/);
    }
    assert.throws(() => createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: idle, pageLimit: 0 }), /page limit/);
    assert.throws(() => createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: idle, maxPages: 0 }), /page bound/);
    assert.throws(() => createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: idle, maxPages: 21 }), /page bound/);
    assert.throws(() => createNeonReadTransport({ projectId: "Proj_Test", token: TOKEN, fetchImpl: idle }), /project id is required/);
    const fullPage = pages(() => jsonResponse({ branches: [branch("br-parent", "stage13-dev", null)] }));
    await assert.rejects(async () => { await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: fullPage.fetchImpl, pageLimit: 1 }).readBranches(); }, /completeness cannot be verified/);
    const shortPage = pages(() => jsonResponse({ branches: [branch("br-parent", "stage13-dev", null)] }));
    const listed = await createNeonReadTransport({ projectId: PROJECT, token: TOKEN, fetchImpl: shortPage.fetchImpl, pageLimit: 2 }).readBranches();
    assert.equal(Array.isArray((listed as { branches: unknown[] }).branches), true);
    assert.match(NEON_CREDENTIAL_POLICY.broadKey, /must not be silently accepted as read-only/);
    assert.match(NEON_CREDENTIAL_POLICY.getOnlyClient, /does not make an API credential read-only/);
  });

  it("rejects a non-GET method and leaves write authority, Stage 14, and F1 unchanged", async () => {
    assert.throws(() => assertNeonReadMethod("POST"), /only GET/);
    assert.throws(() => assertNeonReadMethod("DELETE"), /only GET/);
    assert.doesNotThrow(() => assertNeonReadMethod("GET"));
    const text = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage17/neon-api-transport.ts"), "utf8");
    assert.doesNotMatch(text, /method:\s*"POST"|method:\s*"PUT"|method:\s*"PATCH"|method:\s*"DELETE"|createPrismaSink|getPrismaClient|PrismaClient/);
    assert.equal(allowsDestructiveRehearsal(), false);
    assert.throws(() => authorizeCleanupExecution(), /not available/);
    assert.throws(() => parseStage17Args(["load"]), /mode must be/);
    assert.throws(() => parseStage17Args(["cleanup"]), /mode must be/);
    await assert.rejects(() => runStage17(["dry-run", "--run-id", "offline"]), /not authorized/);
    const guards = fs.readFileSync(path.join(BACKEND, "scripts/migration/stage14/guards.ts"), "utf8");
    assert.match(guards, /ep-rapid-bread-b4gi8ftb/);
    assert.throws(() => createNeonReadTransport({ projectId: "", token: TOKEN, fetchImpl: async () => jsonResponse({}) }), /project id is required/);
  });
});
