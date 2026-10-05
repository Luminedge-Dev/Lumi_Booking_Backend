import type { Collection, Document } from "mongodb";

// Reusable deterministic single-call interception against a REAL Collection,
// used only for the rollback-proof and concurrency-race tests. Two
// requirements, both confirmed necessary against the real MongoDB driver:
//
// - Method binding: the driver's Collection methods rely on their own
//   `this` internally -- every non-intercepted property is delegated via
//   value.bind(target), not a naive object spread, or internal driver calls
//   referencing `this` would break.
// - Predicate-based interception, not unconditional replacement: a bare
//   "replace this method entirely" proxy would also intercept calls the
//   test never intended to touch (a different document, a call outside a
//   session, or an earlier call in a multi-call sequence). The predicate
//   runs over the call's actual arguments and only engages the override
//   when it matches, falling through to the real method otherwise. Every
//   call (intercepted or passed-through) is recorded so a test can assert
//   call order where that matters.
//
// The override receives a bound `proceed()` delegate so it decides whether
// (and when) to run the real operation, rather than the proxy implicitly
// deciding fallthrough on the override's behalf -- this is what makes both
// the barrier-synchronized concurrency cases and the synthetic-result
// rollback cases expressible with the same single helper:
//
//   LAST-SEAT RACE override:
//     async (proceed, ...args) => { await barrier.wait(); return proceed(...args); }
//
//   DOUBLE-CANCEL RACE override:
//     async (proceed, ...args) => {
//       const result = await proceed(...args);
//       if (result) await barrier.wait();
//       return result;
//     }
//
//   ROLLBACK INJECTION override (never calls proceed -- the real write is
//   deliberately skipped):
//     async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
//
//   UNCHECKED-RESULT ROLLBACK override (never calls proceed):
//     async () => { throw new Error("simulated unexpected persistence failure"); }
export interface RecordedCall {
  method: string;
  args: unknown[];
  intercepted: boolean;
}

type AnyFn = (...args: unknown[]) => unknown;

export function interceptCollectionCall<K extends keyof Collection<Document>>(
  real: Collection<Document>,
  method: K,
  predicate: (...args: unknown[]) => boolean,
  override: (proceed: AnyFn, ...args: unknown[]) => unknown,
  callLog: RecordedCall[] = []
): { proxy: Collection<Document>; callLog: RecordedCall[] } {
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== method || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const boundReal = (value as AnyFn).bind(target);
      return (...args: unknown[]) => {
        const matches = predicate(...args);
        callLog.push({ method: String(prop), args, intercepted: matches });
        return matches ? override(boundReal, ...args) : boundReal(...args);
      };
    },
  }) as Collection<Document>;
  return { proxy, callLog };
}
