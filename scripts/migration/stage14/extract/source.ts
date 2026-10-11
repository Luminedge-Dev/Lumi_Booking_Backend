// Stage 14 -- READ-ONLY MongoDB source.
//
// The ONLY place in the ETL that imports the `mongodb` driver. It exposes a
// deliberately tiny surface (count + keyset-batched find) and never hands out
// the driver's Collection/Db/Client, so no caller can reach a write API.
// tests/migration/stage14/boundary.test.ts statically enforces this.
//
// Pagination is keyset on `_id`, never skip(): `_id` is mixed-type in
// bookingMock (ObjectId + string), and BSON orders types before values, so the
// scan walks one type bracket at a time:  string < ObjectId < (anything else).

import { MongoClient, ObjectId, type Document } from "mongodb";
import type { RawDoc, SourceEntity } from "../common";

export type CursorBracket = "string" | "objectId" | "other";

/** Resume token: the last `_id` fully processed inside a type bracket. */
export interface CursorToken {
  bracket: CursorBracket;
  /** string value, or ObjectId hex. Absent only for "other" (never resumed mid-bracket). */
  last: string;
}

export interface ReadBatch {
  docs: RawDoc[];
  /** Token that resumes AFTER this batch. */
  token: CursorToken;
}

export interface ReadOptions {
  batchSize: number;
  resumeAfter?: CursorToken;
  /** `{ _id: 1 }`-style projection for ID-only passes. */
  projection?: Record<string, 0 | 1>;
}

export interface ReadOnlyCollection {
  readonly name: SourceEntity;
  count(): Promise<number>;
  readBatches(options: ReadOptions): AsyncGenerator<ReadBatch>;
}

export interface ReadOnlySource {
  collection(name: SourceEntity): ReadOnlyCollection;
  close(): Promise<void>;
}

const BRACKET_ORDER: readonly CursorBracket[] = ["string", "objectId", "other"];
/** `_id`s that are neither string nor ObjectId are not expected; bound the read. */
export const OTHER_BRACKET_CAP = 1000;
const FIND_MAX_TIME_MS = 60_000;

export function formatToken(token: CursorToken): string {
  return `${token.bracket}:${token.last}`;
}

export function parseToken(text: string): CursorToken {
  const idx = text.indexOf(":");
  const bracket = text.slice(0, idx);
  const last = text.slice(idx + 1);
  if (idx < 0 || (bracket !== "string" && bracket !== "objectId" && bracket !== "other")) {
    throw new Error("Invalid resume token. Expected <string|objectId|other>:<last _id>.");
  }
  if (bracket === "objectId" && !/^[0-9a-fA-F]{24}$/.test(last)) {
    throw new Error("Invalid resume token: objectId bracket needs a 24-hex value.");
  }
  return { bracket, last };
}

function serializeId(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

/**
 * Minimal structural view of the driver collection this module needs. Typed
 * narrowly so the wrapper provably cannot call anything else.
 */
interface FindOnlyCollection {
  countDocuments(filter: Document): Promise<number>;
  find(
    filter: Document,
    options: { projection?: Document; sort: Document; limit: number; maxTimeMS: number }
  ): { toArray(): Promise<Document[]> };
}

export function createReadOnlyCollection(name: SourceEntity, collection: FindOnlyCollection): ReadOnlyCollection {
  return {
    name,
    async count(): Promise<number> {
      return collection.countDocuments({});
    },
    async *readBatches(options: ReadOptions): AsyncGenerator<ReadBatch> {
      if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
        throw new Error("batchSize must be a positive integer");
      }
      const startBracket = options.resumeAfter?.bracket ?? "string";
      const startIndex = BRACKET_ORDER.indexOf(startBracket);

      for (const bracket of BRACKET_ORDER.slice(startIndex)) {
        let last: string | undefined = options.resumeAfter?.bracket === bracket ? options.resumeAfter.last : undefined;
        if (bracket === "other") {
          const filter: Document = { _id: { $not: { $type: ["string", "objectId"] } } };
          const docs = (await collection
            .find(filter, { projection: options.projection, sort: { _id: 1 }, limit: OTHER_BRACKET_CAP + 1, maxTimeMS: FIND_MAX_TIME_MS })
            .toArray()) as RawDoc[];
          if (docs.length > OTHER_BRACKET_CAP) {
            throw new Error(`More than ${OTHER_BRACKET_CAP} documents have an _id that is neither string nor ObjectId; refusing to guess.`);
          }
          if (docs.length > 0) yield { docs, token: { bracket: "other", last: "" } };
          continue;
        }
        for (;;) {
          const idFilter: Document = { $type: bracket === "string" ? "string" : "objectId" };
          if (last !== undefined) idFilter.$gt = bracket === "string" ? last : new ObjectId(last);
          const docs = (await collection
            .find({ _id: idFilter }, { projection: options.projection, sort: { _id: 1 }, limit: options.batchSize, maxTimeMS: FIND_MAX_TIME_MS })
            .toArray()) as RawDoc[];
          if (docs.length === 0) break;
          last = serializeId(docs[docs.length - 1]!._id);
          yield { docs, token: { bracket, last } };
          if (docs.length < options.batchSize) break;
        }
      }
    },
  };
}

const MONGO_DB_NAME = "luminedge";

/**
 * Opens a client against a named database. Never prints the URI. The client
 * is private to this closure; callers receive only ReadOnlyCollection views.
 * `connectReadOnlySource` keeps the Stage 14 database name.
 */
export async function connectReadOnlyDatabase(uri: string, databaseName: string): Promise<ReadOnlySource> {
  if (databaseName.length === 0 || /[/\s]/.test(databaseName)) {
    throw new Error("database name is invalid");
  }
  const client = new MongoClient(uri, {
    appName: databaseName === MONGO_DB_NAME ? "luminedge-stage14-etl-readonly" : "luminedge-stage17-local-readonly",
    retryWrites: false,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 90_000,
    maxPoolSize: 2,
  });
  await client.connect();
  const db = client.db(databaseName);
  return {
    collection: (name) => createReadOnlyCollection(name, db.collection(name) as unknown as FindOnlyCollection),
    close: () => client.close(),
  };
}

/**
 * Opens a client against the Stage 14 SOURCE database (`luminedge`).
 * Never prints the URI.
 */
export async function connectReadOnlySource(uri: string): Promise<ReadOnlySource> {
  return connectReadOnlyDatabase(uri, MONGO_DB_NAME);
}
