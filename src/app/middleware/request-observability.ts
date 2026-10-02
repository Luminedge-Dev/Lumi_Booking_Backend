import type { RequestHandler } from "express";
import { getConfig } from "../config/env";
import { getRequestId } from "../shared/request-context/request-context";
import { logger } from "../shared/logger/logger";

type Clock = () => number;

export interface RequestObservabilityOptions {
  /** Test-only injection, invisible to any real caller. Defaults to performance.now. */
  clock?: Clock;
  /**
   * Test-only injection. node:test's mock.method() cannot mock getConfig()
   * directly -- this project's TS/ESM-interop compiled exports are
   * getter-backed, not plain data properties, which mock.method requires.
   * This resolver is a small seam for tests to simulate getConfig() failing
   * without needing to touch the real config module. Defaults to reading
   * getConfig().slowRequestThresholdMs.
   */
  getSlowRequestThresholdMs?: () => number;
}

// Node can expose a header value as string | number | string[] | undefined
// (res.getHeader can return a number for Content-Length; req.headers values
// are string | string[] | undefined). Accept all of those shapes and only
// ever report a finite, non-negative byte count — never guess, never emit
// a negative/NaN value.
function parseByteLength(headerValue: string | number | string[] | undefined): number | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Factory takes an injectable clock so slow/aborted-request tests can
// simulate elapsed time deterministically, with no real sleep(). Must mount
// immediately after request-id.ts and before helmet(), so measured duration
// covers the whole pipeline. res.on("close") also fires after a normal
// res.on("finish") in Node, so the `completed` guard (not event choice
// alone) is what guarantees exactly one terminal log per request.
//
// requestId is captured ONCE, synchronously, when this middleware first runs
// — not re-read via getRequestId() inside the finish/close callback. The
// callback fires on a Node http/net event (res is an EventEmitter), and we
// don't want correctness to depend on exactly how far AsyncLocalStorage's
// context propagates into low-level HTTP lifecycle events. Closing over a
// value captured at the top of the request's synchronous execution (which
// IS reliably inside request-id.ts's runWithRequestId callback) is simpler
// and removes that dependency entirely.
export function createRequestObservability(options: RequestObservabilityOptions = {}): RequestHandler {
  const clock = options.clock ?? (() => performance.now());
  const getSlowRequestThresholdMs = options.getSlowRequestThresholdMs ?? (() => getConfig().slowRequestThresholdMs);

  return (req, res, next) => {
    // Telemetry initialization itself must not be able to block the
    // request: if clock() or getRequestId() unexpectedly throws, start/
    // requestId simply stay undefined and finish() below no-ops — next()
    // is still called unconditionally.
    let start: number | undefined;
    let requestId: string | undefined;
    try {
      start = clock();
      requestId = getRequestId();
    } catch {
      // Telemetry initialization failed; the request must still proceed.
    }
    let completed = false;

    // The entire body is wrapped in try/catch: getConfig() can throw (e.g. a
    // missing required env var surfaced lazily), and this callback runs
    // inside a Node EventEmitter ("finish"/"close") lifecycle event, not in
    // the middleware chain — an uncaught throw here would become an
    // uncaught exception at the process level, not a normal Express error.
    // Observability must never be able to do that.
    const finish = (event: "http_request_completed" | "http_request_aborted"): void => {
      if (completed) return;
      completed = true;
      if (start === undefined) return; // nothing meaningful to measure/log

      try {
        const durationMs = clock() - start;
        const isSlow = event === "http_request_completed" && durationMs >= getSlowRequestThresholdMs();

        const metadata: Record<string, unknown> = {
          method: req.method,
          path: req.path,
          durationMs,
          requestId,
        };
        if (event === "http_request_completed") {
          metadata.statusCode = res.statusCode;
        }
        const requestBytes = parseByteLength(req.headers["content-length"]);
        if (requestBytes !== undefined) metadata.requestBytes = requestBytes;
        const responseBytes = parseByteLength(res.getHeader("content-length"));
        if (responseBytes !== undefined) metadata.responseBytes = responseBytes;

        if (event === "http_request_aborted") {
          logger.warn("http_request_aborted", metadata);
        } else if (isSlow) {
          logger.warn("http_request_slow", metadata);
        } else {
          logger.info("http_request_completed", metadata);
        }
      } catch {
        // Telemetry failure must never affect the HTTP lifecycle.
      }
    };

    res.on("finish", () => finish("http_request_completed"));
    res.on("close", () => finish("http_request_aborted"));

    next();
  };
}

export const requestObservability: RequestHandler = createRequestObservability();
