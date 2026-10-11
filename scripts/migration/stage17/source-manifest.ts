// Source-document identity for Stage 17. Full SHA-256 over a versioned,
// BSON-tagged encoding. This is not the truncated Stage 14 canonical-row digest.
//
// Two independent facts are stored for every extracted root:
//   source change, decided later by comparing digests and presence
//   transform outcome, taken from AggregateResult.rootQuarantine
// A child quarantine leaves the root outcome "accepted".

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Binary, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp } from "mongodb";
import { SOURCE_ENTITIES, type AggregateResult, type RawDoc, type SourceEntity } from "../stage14/common";

export const SOURCE_DIGEST_VERSION = "source-identity-v1" as const;
export const SOURCE_ENCODING_VERSION = "stage17-bson-tagged-v2" as const;

/** Inventory for a future local snapshot run. Offline fixtures must not be checked against it. */
export const FUTURE_LOCAL_SNAPSHOT_INVENTORY = {
  users: 9205,
  courses: 5,
  schedules: 2457,
  bookingMock: 21210,
} as const;

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,80}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class SourceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceManifestError";
  }
}

export class SourceEncodingError extends Error {
  constructor(observedType: string) {
    super(`unsupported source value: ${observedType}`);
    this.name = "SourceEncodingError";
  }
}

export type IdBracket = "string" | "objectId" | "other";
export type TransformOutcome = "accepted" | "root-quarantined";

export interface SourceDocumentRecord {
  idBracket: IdBracket;
  id: string;
  digest: string;
  outcome: TransformOutcome;
  reasonCode?: string;
  childReasonCodes: string[];
}

export interface SourceScanCount {
  before: number;
  extracted: number;
  after: number;
}

export interface SourceIdentityManifest {
  executionId: string;
  digestVersion: typeof SOURCE_DIGEST_VERSION;
  encodingVersion: typeof SOURCE_ENCODING_VERSION;
  scan: Record<SourceEntity, SourceScanCount>;
  entities: Record<SourceEntity, { documents: SourceDocumentRecord[] }>;
}

export interface SourceIdentityReport {
  comparison: "source-identity";
  digestVersion: typeof SOURCE_DIGEST_VERSION;
  encodingVersion: typeof SOURCE_ENCODING_VERSION;
  sourceAdded: number;
  sourceModified: number;
  sourceDeleted: number;
  sourceUnchanged: number;
  laterAccepted: number;
  laterRootQuarantined: number;
  acceptedToQuarantined: number;
  quarantinedToAccepted: number;
  addedAndRootQuarantined: number;
  modifiedAndRootQuarantined: number;
  countAgreement: boolean;
  interpretation: "Source deletion requires the identity to be absent from the later extract. canonicalRowsAbsent is not a confirmed MongoDB deletion. Count agreement is not point-in-time consistency.";
}

const INTERPRETATION =
  "Source deletion requires the identity to be absent from the later extract. canonicalRowsAbsent is not a confirmed MongoDB deletion. Count agreement is not point-in-time consistency." as const;
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tagged(type: string, value?: unknown): { $t: string; v?: unknown } {
  if (value === undefined) return { $t: type };
  return { $t: type, v: value };
}

function numberToken(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function taggedNumber(value: number, type: string): { $t: string; v: string } {
  return { $t: type, v: numberToken(value) };
}

function encodeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return tagged("null");
  if (value === undefined) return tagged("undefined");
  if (typeof value === "string") return tagged("string", value);
  if (typeof value === "boolean") return tagged("bool", value);
  if (typeof value === "number") return taggedNumber(value, "js-number");
  if (typeof value === "bigint") return tagged("int64", value.toString());
  if (typeof value !== "object") throw new SourceEncodingError(typeof value);
  if (seen.has(value)) throw new SourceEncodingError("circular");
  seen.add(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new SourceEncodingError("invalid date");
    return tagged("date", value.toISOString());
  }
  if (value instanceof ObjectId) return tagged("objectId", value.toHexString());
  if (value instanceof Int32) return taggedNumber(value.valueOf(), "int32");
  if (value instanceof Long) return tagged("int64", value.toString());
  if (value instanceof Double) return taggedNumber(value.valueOf(), "double");
  if (value instanceof Decimal128) return tagged("decimal128", value.toString());
  if (value instanceof Binary) return tagged("binary", { subType: value.sub_type, data: value.toString("base64") });
  if (value instanceof Timestamp) return tagged("timestamp", { t: value.t, i: value.i });
  if (value instanceof MinKey) return tagged("minKey");
  if (value instanceof MaxKey) return tagged("maxKey");
  if (value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
    throw new SourceEncodingError(value.constructor.name.toLowerCase());
  }
  if (Array.isArray(value)) return tagged("array", value.map((entry) => encodeValue(entry, seen)));
  if (Buffer.isBuffer(value)) throw new SourceEncodingError("buffer");
  const bsonType = (value as { _bsontype?: unknown })._bsontype;
  if (typeof bsonType === "string") throw new SourceEncodingError(`bson:${bsonType}`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new SourceEncodingError("symbol-key");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = encodeValue((value as Record<string, unknown>)[key], seen);
  }
  return tagged("document", out);
}

export function sourceDocumentDigest(doc: RawDoc): string {
  const encoded = JSON.stringify(encodeValue(doc, new WeakSet()));
  return createHash("sha256").update(`${SOURCE_ENCODING_VERSION}\n${encoded}`, "utf8").digest("hex");
}

export function sourceIdentityOf(rawId: unknown): { idBracket: IdBracket; id: string } {
  if (rawId instanceof ObjectId) return { idBracket: "objectId", id: rawId.toHexString() };
  if (typeof rawId === "string") return { idBracket: "string", id: rawId };
  const encoded = JSON.stringify(encodeValue(rawId, new WeakSet()));
  return { idBracket: "other", id: createHash("sha256").update(`${SOURCE_ENCODING_VERSION}\n${encoded}`, "utf8").digest("hex") };
}

function outcomeFromAggregate(result: AggregateResult, digest: string, identity: { idBracket: IdBracket; id: string }): SourceDocumentRecord {
  const root = result.rootQuarantine;
  const childReasonCodes = [...new Set(result.childQuarantines.map((entry) => entry.code))].sort();
  if (root) {
    if (!REASON_CODE.test(root.code)) throw new SourceManifestError("quarantine reason code is not a safe token");
    return { ...identity, digest, outcome: "root-quarantined", reasonCode: root.code, childReasonCodes: [] };
  }
  for (const code of childReasonCodes) {
    if (!REASON_CODE.test(code)) throw new SourceManifestError("quarantine reason code is not a safe token");
  }
  return { ...identity, digest, outcome: "accepted", childReasonCodes };
}

export interface SourceRecorder {
  capture(raw: RawDoc): void;
  finish(entity: SourceEntity, result: AggregateResult): void;
  build(scan: Record<SourceEntity, SourceScanCount>): SourceIdentityManifest;
}

/** Holds digests and outcomes only. The raw document is not retained. */
export function createSourceRecorder(): SourceRecorder {
  let pending: { digest: string; idBracket: IdBracket; id: string } | null = null;
  const items: { entity: SourceEntity; record: SourceDocumentRecord }[] = [];
  return {
    capture(raw) {
      pending = { digest: sourceDocumentDigest(raw), ...sourceIdentityOf(raw._id) };
    },
    finish(entity, result) {
      if (!pending) throw new SourceManifestError("source capture is missing");
      const captured = pending;
      pending = null;
      items.push({ entity, record: outcomeFromAggregate(result, captured.digest, captured) });
    },
    build(scan) {
      if (pending) throw new SourceManifestError("source capture is missing");
      return assemble(items, scan);
    },
  };
}

function identityKey(record: Pick<SourceDocumentRecord, "idBracket" | "id">): string {
  return `${record.idBracket}\u0000${record.id}`;
}

function assemble(records: readonly { entity: SourceEntity; record: SourceDocumentRecord }[], scan: Record<SourceEntity, SourceScanCount>): SourceIdentityManifest {
  const entities = {} as SourceIdentityManifest["entities"];
  const seen = new Set<string>();
  for (const entity of SOURCE_ENTITIES) entities[entity] = { documents: [] };
  for (const item of records) {
    const key = `${item.entity}\u0000${identityKey(item.record)}`;
    if (seen.has(key)) throw new SourceManifestError("duplicate source identity");
    seen.add(key);
    entities[item.entity].documents.push(item.record);
  }
  for (const entity of SOURCE_ENTITIES) {
    entities[entity].documents.sort((a, b) => a.idBracket.localeCompare(b.idBracket) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const count = scan[entity];
    if (!count || count.extracted !== entities[entity].documents.length) throw new SourceManifestError("source manifest does not cover every extracted root");
  }
  return { executionId: "00000000-0000-4000-8000-000000000000", digestVersion: SOURCE_DIGEST_VERSION, encodingVersion: SOURCE_ENCODING_VERSION, scan, entities };
}

export function countsAgree(scan: Record<SourceEntity, SourceScanCount>): boolean {
  return SOURCE_ENTITIES.every((entity) => {
    const row = scan[entity];
    return row.before === row.extracted && row.extracted === row.after && row.extracted === scan[entity].extracted;
  });
}

export function inventoryMatches(scan: Record<SourceEntity, SourceScanCount>): boolean {
  return SOURCE_ENTITIES.every((entity) => scan[entity].extracted === FUTURE_LOCAL_SNAPSHOT_INVENTORY[entity]);
}

function isScan(value: unknown): value is SourceScanCount {
  if (typeof value !== "object" || value === null) return false;
  const scan = value as SourceScanCount;
  return [scan.before, scan.extracted, scan.after].every((item) => Number.isInteger(item) && item >= 0);
}

function isRecord(value: unknown): value is SourceDocumentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SourceDocumentRecord;
  if (record.idBracket !== "string" && record.idBracket !== "objectId" && record.idBracket !== "other") return false;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) return false;
  if (!DIGEST_HEX.test(record.digest)) return false;
  if (record.outcome !== "accepted" && record.outcome !== "root-quarantined") return false;
  if (!Array.isArray(record.childReasonCodes) || record.childReasonCodes.some((code) => typeof code !== "string" || !REASON_CODE.test(code))) return false;
  if (record.outcome === "root-quarantined") return typeof record.reasonCode === "string" && REASON_CODE.test(record.reasonCode) && record.childReasonCodes.length === 0;
  return record.reasonCode === undefined;
}

export function parseSourceManifest(value: unknown): SourceIdentityManifest {
  if (typeof value !== "object" || value === null) throw new SourceManifestError("manifest schema is incomplete");
  const body = value as Partial<SourceIdentityManifest>;
  if (body.digestVersion !== SOURCE_DIGEST_VERSION) throw new SourceManifestError("manifest digest version is not source-identity-v1");
  if (typeof body.executionId !== "string" || !EXECUTION_ID.test(body.executionId)) throw new SourceManifestError("manifest schema is incomplete");
  if (body.encodingVersion !== SOURCE_ENCODING_VERSION) throw new SourceManifestError("manifest encoding version is not stage17-bson-tagged-v2");
  if (typeof body.scan !== "object" || body.scan === null || typeof body.entities !== "object" || body.entities === null) {
    throw new SourceManifestError("manifest schema is incomplete");
  }
  const scan = {} as SourceIdentityManifest["scan"];
  const entities = {} as SourceIdentityManifest["entities"];
  for (const entity of SOURCE_ENTITIES) {
    if (!isScan(body.scan[entity]) || !body.entities[entity] || !Array.isArray(body.entities[entity].documents)) {
      throw new SourceManifestError("manifest schema is incomplete");
    }
    scan[entity] = body.scan[entity];
    const seen = new Set<string>();
    const documents: SourceDocumentRecord[] = [];
    for (const item of body.entities[entity].documents) {
      if (!isRecord(item)) throw new SourceManifestError("manifest schema is incomplete");
      const key = identityKey(item);
      if (seen.has(key)) throw new SourceManifestError("duplicate source identity");
      seen.add(key);
      documents.push(item);
    }
    if (documents.length !== scan[entity].extracted) throw new SourceManifestError("manifest schema is incomplete");
    if (scan[entity].before !== scan[entity].extracted || scan[entity].extracted !== scan[entity].after) {
      throw new SourceManifestError("manifest schema is incomplete");
    }
    entities[entity] = { documents };
  }
  return { executionId: body.executionId, digestVersion: SOURCE_DIGEST_VERSION, encodingVersion: SOURCE_ENCODING_VERSION, scan, entities };
}

export function readSourceManifest(file: string): SourceIdentityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new SourceManifestError("manifest schema is incomplete");
  }
  return parseSourceManifest(parsed);
}

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId.includes("..")) throw new SourceManifestError("run id is not safe");
}

export function manifestPath(root: string, runId: string, leaf: "source-identity.json" | "canonical-rows.json"): string {
  assertSafeRunId(runId);
  const base = path.resolve(root);
  const file = path.resolve(base, runId, leaf);
  const relative = path.relative(base, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new SourceManifestError("manifest path escapes the approved directory");
  return file;
}

function assertRealDirectory(root: string, dir: string): void {
  if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) {
    throw new SourceManifestError("manifest directory is a symlink");
  }
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new SourceManifestError("manifest directory is a symlink");
}

export function defaultManifestRoot(): string {
  return path.resolve(__dirname, "../../../_migration/stage17-manifests");
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function assertManifestRoot(root: string, allowTestRoot: boolean): string {
  const base = path.resolve(root);
  if (!allowTestRoot && !samePath(base, defaultManifestRoot())) throw new SourceManifestError("manifest root is not the approved directory");
  return base;
}

export interface FinalizedPair {
  executionId: string;
  directory: string;
}

export function finalizeManifestPair(input: {
  root: string;
  runId: string;
  allowTestRoot: boolean;
  executionId: string;
  source: SourceIdentityManifest;
  canonical: unknown;
}): FinalizedPair {
  if (!EXECUTION_ID.test(input.executionId)) throw new SourceManifestError("manifest schema is incomplete");
  const base = assertManifestRoot(input.root, input.allowTestRoot);
  const finalDir = manifestPath(base, input.runId, "source-identity.json");
  const directory = path.dirname(finalDir);
  if (fs.existsSync(directory)) {
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(directory));
    if (fs.lstatSync(directory).isSymbolicLink() || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SourceManifestError("manifest directory is a symlink");
    }
    throw new SourceManifestError("run id already exists");
  }
  fs.mkdirSync(base, { recursive: true });
  assertRealDirectory(base, base);
  const staging = path.join(base, `.staging-${input.runId}-${process.pid}`);
  fs.mkdirSync(staging);
  try {
    assertRealDirectory(base, staging);
    const source = { ...input.source, executionId: input.executionId };
    const canonical = { ...(input.canonical as object), executionId: input.executionId };
    fs.writeFileSync(path.join(staging, "source-identity.json"), `${JSON.stringify(source)}\n`);
    fs.writeFileSync(path.join(staging, "canonical-rows.json"), `${JSON.stringify(canonical)}\n`);
    fs.renameSync(staging, directory);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { executionId: input.executionId, directory };
}

function indexManifest(manifest: SourceIdentityManifest): Map<string, { entity: SourceEntity; record: SourceDocumentRecord }> {
  const index = new Map<string, { entity: SourceEntity; record: SourceDocumentRecord }>();
  for (const entity of SOURCE_ENTITIES) {
    for (const record of manifest.entities[entity].documents) {
      index.set(`${entity}\u0000${identityKey(record)}`, { entity, record });
    }
  }
  return index;
}

export function compareSourceManifests(earlier: SourceIdentityManifest, later: SourceIdentityManifest): SourceIdentityReport {
  parseSourceManifest(earlier);
  parseSourceManifest(later);
  const before = indexManifest(earlier);
  const after = indexManifest(later);
  const report: SourceIdentityReport = {
    comparison: "source-identity",
    digestVersion: SOURCE_DIGEST_VERSION,
    encodingVersion: SOURCE_ENCODING_VERSION,
    sourceAdded: 0,
    sourceModified: 0,
    sourceDeleted: 0,
    sourceUnchanged: 0,
    laterAccepted: 0,
    laterRootQuarantined: 0,
    acceptedToQuarantined: 0,
    quarantinedToAccepted: 0,
    addedAndRootQuarantined: 0,
    modifiedAndRootQuarantined: 0,
    countAgreement: countsAgree(later.scan),
    interpretation: INTERPRETATION,
  };
  for (const [key, item] of after) {
    if (item.record.outcome === "accepted") report.laterAccepted += 1;
    else report.laterRootQuarantined += 1;
    const previous = before.get(key);
    if (!previous) {
      report.sourceAdded += 1;
      if (item.record.outcome === "root-quarantined") report.addedAndRootQuarantined += 1;
      continue;
    }
    const changed = previous.record.digest !== item.record.digest;
    if (changed) report.sourceModified += 1;
    else report.sourceUnchanged += 1;
    if (previous.record.outcome === "accepted" && item.record.outcome === "root-quarantined") report.acceptedToQuarantined += 1;
    if (previous.record.outcome === "root-quarantined" && item.record.outcome === "accepted") report.quarantinedToAccepted += 1;
    if (changed && item.record.outcome === "root-quarantined") report.modifiedAndRootQuarantined += 1;
  }
  for (const key of before.keys()) {
    if (!after.has(key)) report.sourceDeleted += 1;
  }
  return report;
}
