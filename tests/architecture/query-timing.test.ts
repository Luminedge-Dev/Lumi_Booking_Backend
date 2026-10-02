// Stage 5.5: measureDatabaseOperation coverage. Infrastructure only -- no
// production call sites yet, same pattern as Stage 5's validate-request.ts.
// All timing-sensitive cases use the injected clock parameter; none depend
// on real elapsed time staying above/below the 250ms default threshold.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { measureDatabaseOperation } from "../../src/app/database/query-timing";

function makeFakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("measureDatabaseOperation (architecture)", () => {
  it("resolves with the wrapped function's return value on success (fast clock, no log)", async (t) => {
    const logSpy = t.mock.method(console, "log");
    const warnSpy = t.mock.method(console, "warn");
    const result = await measureDatabaseOperation(
      { collection: "users", operation: "findOne" },
      async () => 42,
      { clock: makeFakeClock([0, 1]) }
    );
    assert.equal(result, 42);
    assert.equal(logSpy.mock.callCount(), 0);
    assert.equal(warnSpy.mock.callCount(), 0);
  });

  it("logs database_operation_slow via console.warn on a slow successful operation, and still resolves normally", async (t) => {
    const warnSpy = t.mock.method(console, "warn");
    const result = await measureDatabaseOperation(
      { collection: "users", operation: "findOne" },
      async () => "ok",
      { clock: makeFakeClock([0, 300]) }
    );
    assert.equal(result, "ok");
    assert.equal(warnSpy.mock.callCount(), 1);
    const parsed = JSON.parse(warnSpy.mock.calls[0].arguments[0] as string);
    assert.equal(parsed.event, "database_operation_slow");
    assert.equal(parsed.collection, "users");
    assert.equal(parsed.operation, "findOne");
  });

  it("fast failure: rethrows the original error unchanged, no slow log", async (t) => {
    const warnSpy = t.mock.method(console, "warn");
    const original = new Error("db down");
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "users", operation: "findOne" },
        async () => {
          throw original;
        },
        { clock: makeFakeClock([0, 1]) }
      ),
      (err: Error) => err === original
    );
    assert.equal(warnSpy.mock.callCount(), 0);
  });

  it("slow failure: rethrows the original error unchanged AND logs database_operation_slow", async (t) => {
    const warnSpy = t.mock.method(console, "warn");
    const original = new Error("db down slowly");
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "users", operation: "findOne" },
        async () => {
          throw original;
        },
        { clock: makeFakeClock([0, 300]) }
      ),
      (err: Error) => err === original
    );
    assert.equal(warnSpy.mock.callCount(), 1);
    const parsed = JSON.parse(warnSpy.mock.calls[0].arguments[0] as string);
    assert.equal(parsed.event, "database_operation_slow");
  });

  it("a thrown non-Error value still propagates unchanged", async () => {
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "x", operation: "y" },
        async () => {
          throw "stringy failure";
        },
        { clock: makeFakeClock([0, 1]) }
      ),
      (err: unknown) => err === "stringy failure"
    );
  });

  it("non-throwing logger invariant: a broken console.warn sink does not replace the original success value", async (t) => {
    t.mock.method(console, "warn", () => {
      throw new Error("sink down");
    });
    const result = await measureDatabaseOperation(
      { collection: "users", operation: "findOne" },
      async () => "preserved",
      { clock: makeFakeClock([0, 300]) }
    );
    assert.equal(result, "preserved");
  });

  it("non-throwing logger invariant: a broken console.warn sink does not replace the original error", async (t) => {
    t.mock.method(console, "warn", () => {
      throw new Error("sink down");
    });
    const original = new Error("real db error");
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "users", operation: "findOne" },
        async () => {
          throw original;
        },
        { clock: makeFakeClock([0, 300]) }
      ),
      (err: Error) => err === original
    );
  });

  it("telemetry failure beyond the logger: a throwing threshold resolver does not replace the original success value", async () => {
    // getConfig() can't be mocked via node:test's mock.method() in this
    // project (its TS/ESM-interop compiled export is getter-backed, not a
    // plain data property) -- use the documented getSlowDbOperationThresholdMs
    // resolver seam instead to simulate a throwing config read.
    const result = await measureDatabaseOperation(
      { collection: "users", operation: "findOne" },
      async () => "preserved",
      {
        clock: makeFakeClock([0, 300]),
        getSlowDbOperationThresholdMs: () => {
          throw new Error("config unavailable");
        },
      }
    );
    assert.equal(result, "preserved");
  });

  it("telemetry failure beyond the logger: a throwing threshold resolver does not replace the original error", async () => {
    const original = new Error("real db error");
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "users", operation: "findOne" },
        async () => {
          throw original;
        },
        {
          clock: makeFakeClock([0, 300]),
          getSlowDbOperationThresholdMs: () => {
            throw new Error("config unavailable");
          },
        }
      ),
      (err: Error) => err === original
    );
  });

  it("initialization failure (clock throws on first call) does not block the wrapped operation (success)", async (t) => {
    const warnSpy = t.mock.method(console, "warn");
    const throwingClock = (): number => {
      throw new Error("clock unavailable");
    };
    const result = await measureDatabaseOperation(
      { collection: "users", operation: "findOne" },
      async () => "still-runs",
      { clock: throwingClock }
    );
    assert.equal(result, "still-runs");
    assert.equal(warnSpy.mock.callCount(), 0);
  });

  it("initialization failure (clock throws on first call) does not block the wrapped operation (failure)", async (t) => {
    const warnSpy = t.mock.method(console, "warn");
    const throwingClock = (): number => {
      throw new Error("clock unavailable");
    };
    const original = new Error("real db error");
    await assert.rejects(
      measureDatabaseOperation(
        { collection: "users", operation: "findOne" },
        async () => {
          throw original;
        },
        { clock: throwingClock }
      ),
      (err: Error) => err === original
    );
    assert.equal(warnSpy.mock.callCount(), 0);
  });
});
