import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

// JSON round trip is the comparison domain: it is exactly what the HTTP layer
// serializes (ObjectId -> hex string, Date -> ISO string, undefined dropped).
export function toWire(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function newTestObjectId(prefix = "ffff5155"): ObjectId {
  // 4-byte timestamp prefix 0xffff5155 (year 2106) makes every parity-test
  // id unmistakable and sorts after every real Stage 14 id.
  const tail = new ObjectId().toHexString().slice(8);
  return new ObjectId(prefix + tail);
}

export const PARITY_ID_PREFIX = "ffff5155";

export interface IntentionalDifference {
  /** field path (dot notation, `[]` for array elements is not used) */
  path: string;
  mongo: unknown;
  postgres: unknown;
  reason: string;
}

// Asserts the two wire values are deeply equal EXCEPT for the declared,
// reasoned differences. A declared difference must actually occur (so a stale
// allowance cannot hide a real regression) and must match exactly.
export function assertParity(
  mongo: unknown,
  postgres: unknown,
  differences: IntentionalDifference[] = [],
  label = "parity"
): void {
  const m = structuredClone(toWire(mongo)) as Record<string, unknown>;
  const p = structuredClone(toWire(postgres)) as Record<string, unknown>;

  for (const diff of differences) {
    const mv = getPath(m, diff.path);
    const pv = getPath(p, diff.path);
    assert.deepEqual(mv, toWire(diff.mongo), `${label}: declared Mongo value at ${diff.path} did not occur (${diff.reason})`);
    assert.deepEqual(pv, toWire(diff.postgres), `${label}: declared PostgreSQL value at ${diff.path} did not occur (${diff.reason})`);
    deletePath(m, diff.path);
    deletePath(p, diff.path);
  }
  assert.deepEqual(p, m, `${label}: undeclared Mongo/PostgreSQL difference`);
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  const parent = keys.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
  if (parent && typeof parent === "object") delete (parent as Record<string, unknown>)[last];
}
