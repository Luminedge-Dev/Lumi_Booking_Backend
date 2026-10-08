// Stage 14 -- real MongoDB (disposable in-memory replica set, never any Atlas/
// production URI): proves the read-only keyset extraction walks a mixed-type
// _id collection (string + ObjectId, as in the real bookingMock) completely,
// in order, resumably, without ever writing to the source.
//
// Run with: pnpm test:stage14:mongo  (suffix .transaction.ts keeps it out of the default sweep)

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId, type Document } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient } from "mongodb";
import { createReadOnlyCollection, formatToken, parseToken, type CursorToken } from "../../../scripts/migration/stage14/extract/source";
import { runPipeline } from "../../../scripts/migration/stage14/pipeline";
import type { ReadOnlySource } from "../../../scripts/migration/stage14/extract/source";
import { SOURCE_ENTITIES } from "../../../scripts/migration/stage14/common";
import { buildWorld, worldSource } from "./helpers/fixtures";
import { memorySink } from "./helpers/memory";

let replSet: MongoMemoryReplSet;
let client: MongoClient;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = new MongoClient(replSet.getUri());
  await client.connect();
});

after(async () => {
  await client?.close();
  await replSet?.stop();
});

async function collectIds(batchSize: number, resumeAfter?: CursorToken, name = "bookingMock") {
  const db = client.db("stage14_extract_test");
  const col = createReadOnlyCollection(name as "bookingMock", db.collection(name) as never);
  const ids: string[] = [];
  let last: CursorToken | undefined;
  for await (const batch of col.readBatches({ batchSize, resumeAfter })) {
    for (const d of batch.docs) ids.push(d._id instanceof ObjectId ? d._id.toHexString() : String(d._id));
    last = batch.token;
  }
  return { ids, last };
}

describe("Stage 14 read-only keyset extraction (real MongoDB)", () => {
  it("walks mixed-type _id (string bracket, then ObjectId bracket) completely and in order, for any batch size", async () => {
    const col = client.db("stage14_extract_test").collection<Document>("bookingMock");
    const stringIds = ["b-str-3", "b-str-1", "b-str-2"];
    const oids = Array.from({ length: 7 }, (_, i) => new ObjectId(`65000000000000000000${(10 + i).toString(16).padStart(4, "0")}`));
    await col.insertMany([...oids.map((_id) => ({ _id })), ...stringIds.map((_id) => ({ _id }))] as Document[]);
    const expected = [...[...stringIds].sort(), ...oids.map((o) => o.toHexString())];

    for (const batchSize of [1, 2, 3, 4, 10, 100]) {
      const { ids } = await collectIds(batchSize);
      assert.deepEqual(ids, expected, `batchSize ${batchSize}`);
    }
  });

  it("resumes after any token without gaps or repeats (including across the string -> ObjectId boundary)", async () => {
    const { ids: all } = await collectIds(2);
    // collect every batch token, then resume from each and compare to the tail
    const col = createReadOnlyCollection("bookingMock", client.db("stage14_extract_test").collection("bookingMock") as never);
    const tokens: CursorToken[] = [];
    for await (const batch of col.readBatches({ batchSize: 2 })) tokens.push(batch.token);
    assert.ok(tokens.some((t) => t.bracket === "string") && tokens.some((t) => t.bracket === "objectId"));
    for (const token of tokens) {
      const { ids } = await collectIds(2, token);
      const position = all.indexOf(token.last);
      assert.deepEqual(ids, all.slice(position + 1), `resume after ${formatToken(token)}`);
    }
  });

  it("round-trips a resume token through its CLI text form", () => {
    const token: CursorToken = { bracket: "objectId", last: "650000000000000000000011" };
    assert.deepEqual(parseToken(formatToken(token)), token);
  });

  it("supports an _id-only projection pass and never modifies the source", async () => {
    const db = client.db("stage14_extract_test");
    const before = await db.collection("bookingMock").countDocuments({});
    const col = createReadOnlyCollection("bookingMock", db.collection("bookingMock") as never);
    let n = 0;
    for await (const batch of col.readBatches({ batchSize: 3, projection: { _id: 1 } })) {
      for (const d of batch.docs) {
        assert.deepEqual(Object.keys(d), ["_id"]);
        n += 1;
      }
    }
    assert.equal(n, before);
    assert.equal(await db.collection("bookingMock").countDocuments({}), before);
    assert.equal(await col.count(), before);
  });

  it("returns an _id that is neither string nor ObjectId from a bounded final bracket instead of skipping it", async () => {
    const db = client.db("stage14_extract_other");
    await db.collection("bookingMock").insertOne({ _id: 12345 as never });
    const col = createReadOnlyCollection("bookingMock", db.collection("bookingMock") as never);
    const seen: unknown[] = [];
    for await (const batch of col.readBatches({ batchSize: 5 })) seen.push(...batch.docs.map((d) => d._id));
    // returned (never silently skipped); more than OTHER_BRACKET_CAP such ids would be refused
    assert.deepEqual(seen, [12345]);
  });

  it("the whole pipeline over real Mongo balances, quarantines nothing for clean data, and leaves the source untouched", async () => {
    const db = client.db("stage14_pipeline_test");
    const world = buildWorld();
    const data = worldSource(world);
    await db.collection("users").insertMany(data.users as Document[]);
    await db.collection("courses").insertMany(data.courses as Document[]);
    await db.collection("schedules").insertMany(data.schedules as Document[]);
    await db.collection("bookingMock").insertMany(data.bookingMock as Document[]);

    const source: ReadOnlySource = {
      collection: (name) => createReadOnlyCollection(name, db.collection(name) as never),
      close: async () => undefined,
    };
    const counts = Object.fromEntries(await Promise.all(SOURCE_ENTITIES.map(async (e) => [e, await db.collection(e).countDocuments({})])));
    const sink = memorySink();
    const real = await runPipeline({ source, sink, batchSize: 1, userBatchSize: 1 });
    assert.deepEqual(real.ledger.unbalanced(), []);
    assert.equal(real.quarantine.length, 0);
    assert.equal(real.sourceCounts.users.extracted, 2);
    // source is untouched by a complete load run
    for (const e of SOURCE_ENTITIES) assert.equal(await db.collection(e).countDocuments({}), counts[e]);
  });
});
