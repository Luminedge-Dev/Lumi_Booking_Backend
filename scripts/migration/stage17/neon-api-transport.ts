// GET-only Neon API discovery transport. The caller supplies fetch.
// This module does not call the network by itself, create a branch, or open a database.
// The token stays in the request closure and is never copied into an error or a result.
//
// GET-only client code does not make an API credential read-only. A project-scoped
// key may still carry write privileges within its project. A future live discovery
// must use an explicitly approved credential with the least privileges Neon supports,
// checked against current Neon documentation. A broadly privileged key is not a
// read-only credential.

import { DiscoveryStopError, LIVE_COLLECTION_COMPLETENESS, type NeonReadTransport } from "./neon-discovery";

export const NEON_API_ORIGIN = "https://console.neon.tech";
export const NEON_API_BASE = "/api/v2";
export const BRANCH_PAGE_LIMIT = LIVE_COLLECTION_COMPLETENESS.branchPageLimit;
export const BRANCH_PAGE_LIMIT_MAX = LIVE_COLLECTION_COMPLETENESS.branchPageLimitMaximum;
export const MAX_BRANCH_PAGES = LIVE_COLLECTION_COMPLETENESS.maxBranchPages;

const PROJECT_ID = /^[a-z0-9-]{1,60}$/;
const MAX_TIMEOUT_MS = 60_000;

/** Credential scope is an operator check. This client cannot prove a key is read-only. */
export const NEON_CREDENTIAL_POLICY = {
  getOnlyClient: "GET-only client code does not make an API credential read-only",
  projectKey: "A project-scoped key may still carry write privileges within its project",
  liveUse: "Future live discovery must use an explicitly approved credential with the least privileges Neon supports",
  documentationCheck: "Credential privileges and organization or project access must be checked against current Neon documentation before live use",
  broadKey: "A broadly privileged key must not be silently accepted as read-only",
} as const;

export const NEON_REDIRECT_POLICY = "error" as const;

export interface NeonApiResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  url?: string;
}

export interface NeonApiRequest {
  method: "GET";
  url: URL;
  redirect: typeof NEON_REDIRECT_POLICY;
  headers: { accept: string; authorization: string };
  signal: AbortSignal;
}

export interface NeonApiFetch {
  (request: NeonApiRequest): Promise<NeonApiResponse>;
}

export interface NeonReadTransportOptions {
  projectId: string;
  token: string;
  fetchImpl: NeonApiFetch;
  timeoutMs?: number;
  pageLimit?: number;
  maxPages?: number;
}

export function assertNeonReadMethod(method: string): void {
  if (method !== "GET") throw new DiscoveryStopError("Neon discovery allows only GET");
}

/** Rejects a request that could follow a redirect or leave the Neon API origin. */
export function assertNeonRequestPolicy(request: { method?: string; redirect?: string; url?: URL }): void {
  assertNeonReadMethod(request.method ?? "");
  if (request.redirect !== NEON_REDIRECT_POLICY) throw new DiscoveryStopError("redirect following is not allowed");
  if (!request.url || request.url.origin !== NEON_API_ORIGIN) throw new DiscoveryStopError("Neon API origin is not approved");
}

export function createNeonReadTransport(options: NeonReadTransportOptions): NeonReadTransport {
  const projectId = options.projectId.trim();
  if (!PROJECT_ID.test(projectId)) throw new DiscoveryStopError("project id is required");
  if (options.token.trim() === "") throw new DiscoveryStopError("Neon API credential is required");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pageLimit = options.pageLimit ?? BRANCH_PAGE_LIMIT;
  const maxPages = options.maxPages ?? MAX_BRANCH_PAGES;
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new DiscoveryStopError("request timeout is outside the allowed range");
  }
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > BRANCH_PAGE_LIMIT_MAX) {
    throw new DiscoveryStopError("branch page limit is outside the documented range");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_BRANCH_PAGES) throw new DiscoveryStopError("branch page bound is outside the allowed range");
  const token = options.token;

  async function getJson(pathname: string, query: Record<string, string>): Promise<unknown> {
    assertNeonReadMethod("GET");
    const url = new URL(`${NEON_API_ORIGIN}${NEON_API_BASE}${pathname}`);
    if (url.origin !== NEON_API_ORIGIN) throw new DiscoveryStopError("Neon API origin is not approved");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    assertApprovedPath(url, projectId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request: NeonApiRequest = {
      method: "GET",
      url,
      redirect: NEON_REDIRECT_POLICY,
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: controller.signal,
    };
    const label = requestLabel(pathname);
    let receivedBody = false;
    try {
      assertNeonRequestPolicy(request);
      const response = await options.fetchImpl(request);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 || location) throw new DiscoveryStopError("unexpected redirect");
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== NEON_API_ORIGIN || finalUrl.pathname !== url.pathname || finalUrl.search !== url.search) {
          throw new DiscoveryStopError("unexpected redirect");
        }
      }
      if (response.status !== 200) throw httpFailure(label, response.status);
      receivedBody = true;
      return await response.json();
    } catch (error) {
      throw redact(error, label, receivedBody);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    readProject() {
      return getJson(`/projects/${projectId}`, {});
    },
    async readBranches() {
      const branches: unknown[] = [];
      const seenIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const query: Record<string, string> = { limit: String(pageLimit), sort_by: "updated_at", sort_order: "desc" };
        if (cursor) query.cursor = cursor;
        const body = await getJson(`/projects/${projectId}/branches`, query);
        const parsed = readBranchPage(body, pageLimit);
        if (parsed.sortOrder !== undefined && parsed.sortOrder !== "desc" && parsed.sortOrder !== "DESC") {
          throw new DiscoveryStopError("branch page order changed");
        }
        for (const branch of parsed.branches) {
          const id = branchId(branch);
          if (id === undefined) throw new DiscoveryStopError("branch id is missing");
          if (seenIds.has(id)) throw new DiscoveryStopError("branch id is duplicated");
          seenIds.add(id);
          branches.push(branch);
        }
        if (parsed.next === undefined) return { branches };
        if (parsed.next.trim() === "") throw new DiscoveryStopError("pagination marker is missing");
        if (seenCursors.has(parsed.next) || parsed.next === cursor) throw new DiscoveryStopError("pagination marker is repeated");
        seenCursors.add(parsed.next);
        cursor = parsed.next;
      }
      throw new DiscoveryStopError("branch collection is incomplete");
    },
    async readEndpoints() {
      const body = await getJson(`/projects/${projectId}/endpoints`, {});
      if (typeof body !== "object" || body === null || Array.isArray(body) || !Array.isArray((body as { endpoints?: unknown }).endpoints)) {
        throw new DiscoveryStopError("endpoint response is incomplete");
      }
      if (Object.hasOwn(body, "pagination")) throw new DiscoveryStopError("endpoint list pagination is outside the documented contract");
      return body;
    },
  };
}

export function createNeonFetchAdapter(fetchFn: (input: URL, init: { method: "GET"; redirect: "error"; headers: { accept: string; authorization: string }; signal: AbortSignal }) => Promise<NeonApiResponse>): NeonApiFetch {
  return async (request) => {
    assertNeonRequestPolicy(request);
    if (request.url.origin !== NEON_API_ORIGIN) throw new DiscoveryStopError("Neon API origin is not approved");
    return fetchFn(request.url, {
      method: "GET",
      redirect: NEON_REDIRECT_POLICY,
      headers: {
        accept: request.headers.accept,
        authorization: request.url.origin === NEON_API_ORIGIN ? request.headers.authorization : "",
      },
      signal: request.signal,
    });
  };
}

function assertApprovedPath(url: URL, projectId: string): void {
  const projectPath = `${NEON_API_BASE}/projects/${projectId}`;
  const allowed = new Set([projectPath, `${projectPath}/branches`, `${projectPath}/endpoints`]);
  if (url.origin !== NEON_API_ORIGIN || !allowed.has(url.pathname)) throw new DiscoveryStopError("Neon API path is not approved");
}

function readBranchPage(value: unknown, pageLimit: number): { branches: unknown[]; next: string | undefined; sortOrder: string | undefined } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DiscoveryStopError("branch response is incomplete");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.branches)) throw new DiscoveryStopError("branch response is incomplete");
  if (body.pagination === undefined) {
    if (body.branches.length >= pageLimit) throw new DiscoveryStopError("branch collection completeness cannot be verified");
    return { branches: body.branches, next: undefined, sortOrder: undefined };
  }
  if (typeof body.pagination !== "object" || body.pagination === null || Array.isArray(body.pagination)) {
    throw new DiscoveryStopError("pagination marker is missing");
  }
  const pagination = body.pagination as Record<string, unknown>;
  if (!Object.hasOwn(pagination, "next")) return { branches: body.branches, next: undefined, sortOrder: stringOrUndefined(pagination.sort_order) };
  if (typeof pagination.next !== "string") throw new DiscoveryStopError("pagination marker is missing");
  return { branches: body.branches, next: pagination.next, sortOrder: stringOrUndefined(pagination.sort_order) };
}

function branchId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type RequestLabel = "project" | "branches" | "endpoints";

function requestLabel(pathname: string): RequestLabel {
  if (pathname.endsWith("/branches")) return "branches";
  if (pathname.endsWith("/endpoints")) return "endpoints";
  return "project";
}

function httpFailure(label: RequestLabel, status: number): DiscoveryStopError {
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "unavailable";
  const kind = status === 401 ? "credential rejected"
    : status === 403 ? "credential forbidden"
    : status === 404 ? "resource not found"
    : status === 429 ? "rate limited"
    : status >= 500 && status <= 599 ? "server error"
    : "http failure";
  return new DiscoveryStopError(`Neon API ${label} request failed status ${code} ${kind}`);
}

function redact(error: unknown, label: RequestLabel, receivedBody: boolean): DiscoveryStopError {
  if (error instanceof DiscoveryStopError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return new DiscoveryStopError(`Neon API ${label} request timed out`);
  if (receivedBody) return new DiscoveryStopError(`Neon API ${label} request failed response unreadable`);
  return new DiscoveryStopError(`Neon API ${label} request failed network`);
}
