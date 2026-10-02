// Stage 5.5: request-id / request-context / logger / request-observability
// coverage. Follows the same node:test + supertest + throwaway-express-app
// conventions as tests/architecture/middleware-foundation.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import type { Request, Response } from "express";
import { requestIdMiddleware } from "../../src/app/middleware/request-id";
import { createRequestObservability } from "../../src/app/middleware/request-observability";
import { notFoundHandler } from "../../src/app/middleware/not-found";
import { errorHandler } from "../../src/app/middleware/error-handler";
import { getRequestId } from "../../src/app/shared/request-context/request-context";
import { logger } from "../../src/app/shared/logger/logger";
import { AppError } from "../../src/app/shared/errors/app-error";
import { CORS_REJECTION_MESSAGE } from "../../src/app/middleware/cors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLoggedCall(call: { arguments: unknown[] }): Record<string, unknown> {
  return JSON.parse(call.arguments[0] as string);
}

describe("request-id middleware (architecture)", () => {
  it("generates a UUID-shaped x-request-id when the client sends none", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/");
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("echoes back a valid client-supplied x-request-id", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/").set("x-request-id", "abc-123");
    assert.equal(res.headers["x-request-id"], "abc-123");
  });

  it("replaces an oversized (>128 char) client-supplied x-request-id with a generated UUID", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const oversized = "a".repeat(200);
    const res = await request(app).get("/").set("x-request-id", oversized);
    assert.notEqual(res.headers["x-request-id"], oversized);
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("replaces an empty-string client-supplied x-request-id", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/").set("x-request-id", "");
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("replaces a whitespace-only client-supplied x-request-id", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/").set("x-request-id", "   ");
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("replaces a comma/joined duplicate-header-style value", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/").set("x-request-id", "a,b,c");
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("replaces a client-supplied id containing disallowed characters", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/").set("x-request-id", " weird value ");
    assert.match(res.headers["x-request-id"], UUID_PATTERN);
  });

  it("a downstream handler's getRequestId() matches the response header", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ requestId: getRequestId() }));
    const res = await request(app).get("/");
    assert.equal(res.body.requestId, res.headers["x-request-id"]);
  });

  it("x-request-id is present even on a 404", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(notFoundHandler);
    const res = await request(app).get("/nope");
    assert.ok(res.headers["x-request-id"]);
  });

  it("x-request-id is present even on an error-handler 500 response", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, _res, next) => next(new Error("boom")));
    app.use(errorHandler);
    const res = await request(app).get("/");
    assert.equal(res.status, 500);
    assert.ok(res.headers["x-request-id"]);
  });
});

function makeFakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function buildObservabilityApp(clock: () => number): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(createRequestObservability({ clock }));
  app.get("/", (_req, res) => res.status(200).json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const ALLOWED_LOG_KEYS = new Set([
  "level",
  "event",
  "requestId",
  "timestamp",
  "method",
  "path",
  "statusCode",
  "durationMs",
  "requestBytes",
  "responseBytes",
]);

describe("request-observability middleware (architecture)", () => {
  it("logs http_request_completed via console.log with correlated requestId on a normal fast request", async (t) => {
    const logSpy = t.mock.method(console, "log");
    const app = buildObservabilityApp(makeFakeClock([0, 10]));
    const res = await request(app).get("/");

    assert.equal(logSpy.mock.callCount(), 1);
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    assert.equal(parsed.event, "http_request_completed");
    assert.equal(parsed.durationMs, 10);
    assert.equal(parsed.statusCode, 200);
    assert.equal(parsed.requestId, res.headers["x-request-id"]);
    for (const key of Object.keys(parsed)) {
      assert.ok(ALLOWED_LOG_KEYS.has(key), `unexpected log key: ${key}`);
    }
  });

  it("logs http_request_slow via console.warn (not console.log) when duration meets the default threshold", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(createRequestObservability({ clock: makeFakeClock([0, 1500]) }));
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));

    await new Promise<void>((resolve, reject) => {
      const realLog = console.log;
      const realWarn = console.warn;
      const logCalls: unknown[][] = [];
      const warnCalls: unknown[][] = [];
      console.log = (...args: unknown[]) => logCalls.push(args);
      console.warn = (...args: unknown[]) => warnCalls.push(args);
      request(app)
        .get("/")
        .then((res) => {
          console.log = realLog;
          console.warn = realWarn;
          try {
            assert.equal(res.status, 200);
            assert.equal(logCalls.length, 0, "no console.log call for a slow request");
            assert.equal(warnCalls.length, 1);
            const parsed = JSON.parse(warnCalls[0][0] as string);
            assert.equal(parsed.event, "http_request_slow");
            resolve();
          } catch (err) {
            reject(err);
          }
        })
        .catch((err) => {
          console.log = realLog;
          console.warn = realWarn;
          reject(err);
        });
    });
  });

  it("does not log http_request_slow when duration is just under the default threshold", async (t) => {
    const logSpy = t.mock.method(console, "log");
    const warnSpy = t.mock.method(console, "warn");
    const app = buildObservabilityApp(makeFakeClock([0, 999]));
    await request(app).get("/");
    assert.equal(warnSpy.mock.callCount(), 0);
    assert.equal(logSpy.mock.callCount(), 1);
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    assert.equal(parsed.event, "http_request_completed");
  });

  function fakeReqRes(): { req: Request; res: Response & EventEmitter } {
    const req = { method: "GET", path: "/fake", headers: {} } as unknown as Request;
    class FakeRes extends EventEmitter {
      statusCode = 200;
      getHeader(_name: string): undefined {
        return undefined;
      }
    }
    const res = new FakeRes() as unknown as Response & EventEmitter;
    return { req, res };
  }

  it("logs http_request_aborted via console.warn when the response closes without finishing", (t, done) => {
    const warnSpy = t.mock.method(console, "warn");
    const logSpy = t.mock.method(console, "log");
    const { req, res } = fakeReqRes();
    const middleware = createRequestObservability({ clock: makeFakeClock([0, 5]) });
    middleware(req, res, () => {
      res.emit("close");
      queueMicrotask(() => {
        assert.equal(logSpy.mock.callCount(), 0);
        assert.equal(warnSpy.mock.callCount(), 1);
        const parsed = parseLoggedCall(warnSpy.mock.calls[0]);
        assert.equal(parsed.event, "http_request_aborted");
        done();
      });
    });
  });

  it("only ever logs once even if both finish and close fire for the same request", (t, done) => {
    const warnSpy = t.mock.method(console, "warn");
    const logSpy = t.mock.method(console, "log");
    const { req, res } = fakeReqRes();
    const middleware = createRequestObservability({ clock: makeFakeClock([0, 5]) });
    middleware(req, res, () => {
      res.emit("finish");
      res.emit("close");
      queueMicrotask(() => {
        assert.equal(logSpy.mock.callCount() + warnSpy.mock.callCount(), 1);
        done();
      });
    });
  });

  it("requestBytes is absent (not reported) on a GET request with no body/content-length", async (t) => {
    const logSpy = t.mock.method(console, "log");
    const app = buildObservabilityApp(makeFakeClock([0, 1]));
    await request(app).get("/");
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    assert.ok(!("requestBytes" in parsed));
  });

  it("responseBytes is absent (not reported) when res.getHeader('content-length') returns nothing", (t, done) => {
    const logSpy = t.mock.method(console, "log");
    const { req, res } = fakeReqRes();
    const middleware = createRequestObservability({ clock: makeFakeClock([0, 1]) });
    middleware(req, res, () => {
      res.emit("finish");
      queueMicrotask(() => {
        const parsed = parseLoggedCall(logSpy.mock.calls[0]);
        assert.ok(!("responseBytes" in parsed));
        done();
      });
    });
  });

  it("responseBytes is reported when content-length is present on the response", async (t) => {
    const logSpy = t.mock.method(console, "log");
    const app = express();
    app.use(requestIdMiddleware);
    app.use(createRequestObservability({ clock: makeFakeClock([0, 1]) }));
    app.get("/", (_req, res) => {
      const body = JSON.stringify({ ok: true });
      res.setHeader("content-length", Buffer.byteLength(body));
      res.status(200).send(body);
    });
    await request(app).get("/");
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    assert.equal(parsed.responseBytes, Buffer.byteLength(JSON.stringify({ ok: true })));
  });

  it("a negative or non-numeric content-length value is treated as absent, never reported", (t, done) => {
    const logSpy = t.mock.method(console, "log");
    const { req, res } = fakeReqRes();
    (res as unknown as { getHeader: (name: string) => string }).getHeader = () => "not-a-number";
    const middleware = createRequestObservability({ clock: makeFakeClock([0, 1]) });
    middleware(req, res, () => {
      res.emit("finish");
      queueMicrotask(() => {
        const parsed = parseLoggedCall(logSpy.mock.calls[0]);
        assert.ok(!("responseBytes" in parsed));
        done();
      });
    });
  });

  it("initialization failure (clock throws on first call) does not block the request", async () => {
    const throwingClock = (): number => {
      throw new Error("clock unavailable");
    };
    const app = express();
    app.use(requestIdMiddleware);
    app.use(createRequestObservability({ clock: throwingClock }));
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("telemetry failure during terminal logging does not break the HTTP response", async () => {
    // getConfig() can't be mocked via node:test's mock.method() in this
    // project (its TS/ESM-interop compiled export is getter-backed, not a
    // plain data property) -- use the documented getSlowRequestThresholdMs
    // resolver seam instead to simulate a throwing config read.
    const app = express();
    app.use(requestIdMiddleware);
    app.use(
      createRequestObservability({
        clock: makeFakeClock([0, 10]),
        getSlowRequestThresholdMs: () => {
          throw new Error("config unavailable");
        },
      })
    );
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });
});

describe("logger (architecture)", () => {
  it("info/warn/error dispatch to console.log/console.warn/console.error respectively", (t) => {
    const logSpy = t.mock.method(console, "log");
    const warnSpy = t.mock.method(console, "warn");
    const errorSpy = t.mock.method(console, "error");

    logger.info("test_info", {});
    logger.warn("test_warn", {});
    logger.error("test_error", {});

    assert.equal(logSpy.mock.callCount(), 1);
    assert.equal(warnSpy.mock.callCount(), 1);
    assert.equal(errorSpy.mock.callCount(), 1);
  });

  it("never includes authorization/cookie/body/password/token keys for real call-site metadata shapes", (t) => {
    const logSpy = t.mock.method(console, "log");
    logger.info("http_request_completed", { method: "GET", path: "/x", durationMs: 1, statusCode: 200 });
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    for (const forbidden of ["authorization", "cookie", "body", "password", "token"]) {
      assert.ok(!(forbidden in parsed), `must not include ${forbidden}`);
    }
  });

  it("a metadata object containing { event: \"corrupted\" } does not change the logged event field", (t) => {
    const logSpy = t.mock.method(console, "log");
    logger.info("real_event", { event: "corrupted" });
    const parsed = parseLoggedCall(logSpy.mock.calls[0]);
    assert.equal(parsed.event, "real_event");
  });

  it("when console.log is mocked to throw, logger.info does not throw", (t) => {
    t.mock.method(console, "log", () => {
      throw new Error("sink down");
    });
    assert.doesNotThrow(() => logger.info("some_event", {}));
  });
});

describe("error-handler + request context correlation (architecture)", () => {
  function buildErrorApp(): express.Express {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (_req, _res, next) => next(new Error("boom")));
    app.get("/app-error", (_req, _res, next) => {
      next(AppError.badRequest("bad"));
    });
    app.get("/cors-error", (_req, _res, next) => {
      next(new Error(CORS_REJECTION_MESSAGE));
    });
    app.get("/async-error", async (_req, _res, next) => {
      await Promise.resolve();
      next(new Error("boom"));
    });
    app.use(errorHandler);
    return app;
  }

  it("an unexpected error's response contract is unchanged with request-id now in the pipeline", async () => {
    const res = await request(buildErrorApp()).get("/");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: "An unexpected error occurred. Please try again later." });
  });

  it("logs http_request_error via console.error with a requestId matching the response header", async (t) => {
    const errorSpy = t.mock.method(console, "error");
    const res = await request(buildErrorApp()).get("/");
    assert.equal(errorSpy.mock.callCount(), 1);
    const parsed = parseLoggedCall(errorSpy.mock.calls[0]);
    assert.equal(parsed.event, "http_request_error");
    assert.equal(parsed.requestId, res.headers["x-request-id"]);
    assert.ok(typeof parsed.stack === "string" && parsed.stack.length > 0);
    assert.ok(!JSON.stringify(res.body).includes("boom"));
  });

  it("an AppError response triggers zero console.error calls", async (t) => {
    const errorSpy = t.mock.method(console, "error");
    await request(buildErrorApp()).get("/app-error");
    assert.equal(errorSpy.mock.callCount(), 0);
  });

  it("a CORS-rejection response triggers zero console.error calls", async (t) => {
    const errorSpy = t.mock.method(console, "error");
    await request(buildErrorApp()).get("/cors-error");
    assert.equal(errorSpy.mock.callCount(), 0);
  });

  it("the same x-request-id survives an async boundary and reaches http_request_error", async (t) => {
    const errorSpy = t.mock.method(console, "error");
    const res = await request(buildErrorApp()).get("/async-error");
    assert.equal(res.status, 500);
    const parsed = parseLoggedCall(errorSpy.mock.calls[0]);
    assert.equal(parsed.requestId, res.headers["x-request-id"]);
  });
});

describe("AsyncLocalStorage concurrency isolation (architecture)", () => {
  it("two concurrent requests keep separate request IDs across an async boundary", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/echo", async (_req, res) => {
      await Promise.resolve();
      res.status(200).json({ requestId: getRequestId() });
    });

    const [a, b] = await Promise.all([
      request(app).get("/echo").set("x-request-id", "request-a"),
      request(app).get("/echo").set("x-request-id", "request-b"),
    ]);

    assert.equal(a.body.requestId, "request-a");
    assert.equal(b.body.requestId, "request-b");
  });
});
