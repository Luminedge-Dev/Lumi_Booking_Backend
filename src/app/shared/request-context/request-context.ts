import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContextStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
