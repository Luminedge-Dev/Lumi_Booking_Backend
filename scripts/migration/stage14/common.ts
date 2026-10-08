// Stage 14 -- shared primitives for the Mongo -> PostgreSQL ETL.
//
// Pure, side-effect-free helpers only: identifiers, deterministic child IDs,
// strict date parsing, BSON -> JSON-safe conversion, canonical digests, and
// the quarantine/aggregate result types shared by every transform.
//
// Nothing here reads the environment or touches any database.

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

export type RawDoc = Record<string, unknown>;

export type SourceEntity = "users" | "courses" | "schedules" | "bookingMock";

export const SOURCE_ENTITIES: readonly SourceEntity[] = ["users", "courses", "schedules", "bookingMock"];

/** Every PostgreSQL table Stage 14 writes. Order = deterministic report order. */
export const TABLES = [
  "users",
  "courses",
  "schedules",
  "schedule_slots",
  "slot_counters",
  "mock_allocations",
  "bookings",
  "teacher_assignments",
  "feedback_entries",
  "feedback_status",
  "admin_sections",
  "trf_emails",
  "trf_email_history",
] as const;
export type TableName = (typeof TABLES)[number];

/** Better Auth tables. Stage 14 must leave them untouched and empty. */
export const BETTER_AUTH_TABLES = ["sessions", "accounts", "verifications"] as const;

export type Row = Record<string, unknown>;

/** One transform batch worth of rows, grouped by target table. */
export type TableRows = Partial<Record<TableName, Row[]>>;

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

export interface QuarantineEntry {
  entity: SourceEntity;
  /** The row kind that was withheld (a root table or a child table). */
  kind: TableName;
  /** Source document _id (canonical hex when derivable). Never a field value. */
  sourceId: string;
  /** Where inside the document, e.g. "root", "mocks[3]", "teachersBySchedule.<key>". */
  scope: string;
  code: string;
  field?: string;
  /** BSON/JS type label only -- never the value. */
  observedType?: string;
  /** Static, PII-free summary. */
  summary: string;
  /** Number of source units this entry withholds (>=1). */
  units: number;
}

/** What a per-document transform hands back to the pipeline. */
export interface AggregateResult {
  entity: SourceEntity;
  sourceId: string;
  /** Source units counted independently from the RAW document. */
  sourceUnits: Partial<Record<TableName, number>>;
  /** Present iff the root document was accepted. */
  rows?: TableRows;
  /** Present iff the root document was rejected (children then withheld too). */
  rootQuarantine?: QuarantineEntry;
  /** Child-level withholdings when the root was accepted. */
  childQuarantines: QuarantineEntry[];
  /** Informational findings that did not withhold anything. */
  findings: Finding[];
}

export interface Finding {
  code: string;
  scope: string;
  count: number;
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is RawDoc {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId);
}

export function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof ObjectId) return "objectId";
  if (typeof value === "object") {
    const bsonType = (value as { _bsontype?: unknown })._bsontype;
    return typeof bsonType === "string" ? `bson:${bsonType}` : "object";
  }
  return typeof value;
}

/** Canonical lowercase 24-hex id, or undefined when the value is not ObjectId-shaped. */
export function canonicalHexId(raw: unknown): string | undefined {
  if (raw instanceof ObjectId) return raw.toHexString();
  if (typeof raw === "string" && /^[0-9a-fA-F]{24}$/.test(raw)) return raw.toLowerCase();
  return undefined;
}

/** Best-effort identifier for triage. Falls back to a type tag, never a value dump. */
export function sourceIdOf(raw: unknown): string {
  return canonicalHexId(raw) ?? `invalid-id:${typeLabel(raw)}`;
}

// UUIDv5 (RFC 4122 name-based, SHA-1). Used ONLY to give child rows a stable
// identity so re-running the ETL replaces rows instead of duplicating them.
const STAGE14_NAMESPACE = "9b3c2f4a-6d1e-5a77-8c0b-5d14e3a14a14";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

export function deterministicUuid(name: string): string {
  const hash = createHash("sha1").update(uuidToBytes(STAGE14_NAMESPACE)).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Typed field readers (strict; never coerce across types)
// ---------------------------------------------------------------------------

export type ReadOk<T> = { ok: true; value: T };
export type ReadFail = { ok: false; code: string; field: string; observedType: string };
export type Read<T> = ReadOk<T> | ReadFail;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

function bad(code: string, field: string, value: unknown): ReadFail {
  return { ok: false, code, field, observedType: typeLabel(value) };
}

/** string | null | undefined -> string | null (absent collapses to null, the documented single collapse). */
export function readOptString(obj: RawDoc, key: string): Read<string | null> {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return bad("INVALID_STRING_SHAPE", key, v);
  return { ok: true, value: v };
}

export function readOptBoolean(obj: RawDoc, key: string): Read<boolean | null> {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "boolean") return bad("INVALID_BOOLEAN_SHAPE", key, v);
  return { ok: true, value: v };
}

/** Integers only, within INT32. Fractions/overflow are quarantined, never truncated. */
export function readOptInt(obj: RawDoc, key: string): Read<number | null> {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  return readIntValue(v, key);
}

export function readIntValue(v: unknown, field: string): Read<number> {
  if (typeof v !== "number" || !Number.isFinite(v)) return bad("INVALID_NUMBER_SHAPE", field, v);
  if (!Number.isInteger(v)) return bad("NON_INTEGER_NUMBER", field, v);
  if (v > INT32_MAX || v < INT32_MIN) return bad("INTEGER_OUT_OF_RANGE", field, v);
  return { ok: true, value: v };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A real Date, or a strict ISO-8601 instant string. Nothing else. */
export function parseInstant(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "string" && ISO_INSTANT.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function readOptInstant(obj: RawDoc, key: string): Read<Date | null> {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  const d = parseInstant(v);
  if (!d) return bad("INVALID_DATE_SHAPE", key, v);
  return { ok: true, value: d };
}

/** Strict YYYY-MM-DD that survives a UTC round-trip (rejects 2026-02-31). */
export function parseCalendarDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10) === v ? d : undefined;
}

export function sqlText(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------
// JSON-safe conversion for scoped JSONB passthrough blobs
// ---------------------------------------------------------------------------

export class UnsupportedJsonValueError extends Error {
  constructor(public readonly observedType: string) {
    super(`unsupported value for JSONB passthrough: ${observedType}`);
  }
}

export interface JsonConversionStats {
  dates: number;
  objectIds: number;
}

/** Converts BSON-decoded data into plain JSON. Throws on anything not losslessly representable. */
export function toJsonValue(value: unknown, stats?: JsonConversionStats): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsupportedJsonValueError("non-finite number");
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new UnsupportedJsonValueError("invalid date");
    if (stats) stats.dates += 1;
    return value.toISOString();
  }
  if (value instanceof ObjectId) {
    if (stats) stats.objectIds += 1;
    return value.toHexString();
  }
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry === undefined ? null : entry, stats));
  if (typeof value === "object") {
    if (typeof (value as { _bsontype?: unknown })._bsontype === "string") {
      throw new UnsupportedJsonValueError(typeLabel(value));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJsonValue(v, stats);
    }
    return out;
  }
  throw new UnsupportedJsonValueError(typeLabel(value));
}

/** PostgreSQL text/jsonb cannot hold NUL. Detect it rather than letting a load fail or silently strip it. */
export function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k.includes("\u0000") || containsNul(v));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canonical digests (idempotency + reconciliation fingerprints)
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function shortDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Group identity for reports that must not reveal an e-mail address. */
export function opaqueGroupKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}
