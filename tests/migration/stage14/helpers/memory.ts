// Stage 14 test doubles: an in-memory READ-ONLY source and an in-memory sink
// that reproduces the loader's atomic replace-by-root-id contract. No database
// of any kind is touched.

import { ObjectId } from "mongodb";
import type { RawDoc, Row, SourceEntity, TableName } from "../../../../scripts/migration/stage14/common";
import { SOURCE_ENTITIES } from "../../../../scripts/migration/stage14/common";
import { TABLE_SPECS } from "../../../../scripts/migration/stage14/columns";
import type { ReadBatch, ReadOnlyCollection, ReadOnlySource, ReadOptions } from "../../../../scripts/migration/stage14/extract/source";
import type { CommitBatch, RowSink } from "../../../../scripts/migration/stage14/load/sink";

function idText(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

/** Same ordering the real keyset walk uses: string ids, then ObjectIds. */
function bracketOf(id: unknown): "string" | "objectId" | "other" {
  if (typeof id === "string") return "string";
  if (id instanceof ObjectId) return "objectId";
  return "other";
}

function sortDocs(docs: RawDoc[]): RawDoc[] {
  const rank = { string: 0, objectId: 1, other: 2 } as const;
  return [...docs].sort((a, b) => {
    const ra = rank[bracketOf(a._id)];
    const rb = rank[bracketOf(b._id)];
    if (ra !== rb) return ra - rb;
    const ta = idText(a._id);
    const tb = idText(b._id);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

export function memorySource(data: Partial<Record<SourceEntity, RawDoc[]>>): ReadOnlySource & { readCalls: number } {
  const state = { readCalls: 0 };
  const collections = new Map<SourceEntity, RawDoc[]>();
  for (const entity of SOURCE_ENTITIES) collections.set(entity, sortDocs(data[entity] ?? []));

  const make = (name: SourceEntity): ReadOnlyCollection => ({
    name,
    async count() {
      return collections.get(name)!.length;
    },
    async *readBatches(options: ReadOptions): AsyncGenerator<ReadBatch> {
      state.readCalls += 1;
      const docs = collections.get(name)!;
      let start = 0;
      if (options.resumeAfter) {
        const { bracket, last } = options.resumeAfter;
        start = docs.findIndex((d) => {
          const b = bracketOf(d._id);
          if (b !== bracket) return false;
          return idText(d._id) > last;
        });
        if (start < 0) {
          // everything in that bracket is consumed: continue with the first later bracket
          const order = ["string", "objectId", "other"] as const;
          const after = order.slice(order.indexOf(bracket) + 1);
          start = docs.findIndex((d) => after.includes(bracketOf(d._id) as never));
          if (start < 0) return;
        }
      }
      for (let i = start; i < docs.length; i += options.batchSize) {
        const slice = docs.slice(i, i + options.batchSize);
        const lastDoc = slice[slice.length - 1]!;
        yield { docs: slice, token: { bracket: bracketOf(lastDoc._id), last: idText(lastDoc._id) } };
      }
    },
  });

  const source = {
    collection: (name: SourceEntity) => make(name),
    async close() {},
    get readCalls() {
      return state.readCalls;
    },
  };
  return source as ReadOnlySource & { readCalls: number };
}

const OWNER: Record<TableName, string> = {
  users: "id",
  courses: "id",
  schedules: "id",
  schedule_slots: "scheduleId",
  slot_counters: "scheduleId",
  mock_allocations: "userId",
  bookings: "id",
  teacher_assignments: "userId",
  feedback_entries: "userId",
  feedback_status: "userId",
  admin_sections: "userId",
  trf_emails: "userId",
  trf_email_history: "userId",
};

const ENTITY_TABLES: Record<SourceEntity, TableName[]> = {
  users: ["users", "mock_allocations", "teacher_assignments", "feedback_entries", "feedback_status", "admin_sections", "trf_emails", "trf_email_history"],
  courses: ["courses"],
  schedules: ["schedules", "schedule_slots", "slot_counters"],
  bookingMock: ["bookings"],
};

export interface MemorySink extends RowSink {
  tables: Map<TableName, Map<string, Row>>;
  commits: number;
  snapshot(): Record<string, string[]>;
}

/**
 * `failAtCommit` (1-based) throws INSIDE the commit after staging work, to prove
 * a failed batch leaves no partial state (the staged copy is simply discarded).
 */
export function memorySink(options: { failAtCommit?: number } = {}): MemorySink {
  const tables = new Map<TableName, Map<string, Row>>();
  let commits = 0;
  let attempts = 0;
  const sink: MemorySink = {
    tables,
    get commits() {
      return commits;
    },
    async commit(batch: CommitBatch): Promise<void> {
      attempts += 1;
      const staged = new Map<TableName, Map<string, Row>>();
      for (const [t, rows] of tables) staged.set(t, new Map(rows));
      for (const table of ENTITY_TABLES[batch.entity]) {
        const rows = staged.get(table) ?? new Map<string, Row>();
        for (const [pk, row] of rows) if (batch.rootIds.includes(String(row[OWNER[table]]))) rows.delete(pk);
        staged.set(table, rows);
      }
      for (const table of ENTITY_TABLES[batch.entity]) {
        for (const row of batch.rows[table] ?? []) {
          const pk = String(row[TABLE_SPECS[table].pk]);
          const rows = staged.get(table)!;
          if (rows.has(pk)) throw new Error(`duplicate primary key in ${table}`);
          rows.set(pk, row);
        }
      }
      if (options.failAtCommit === attempts) throw new Error("injected batch failure");
      tables.clear();
      for (const [t, rows] of staged) tables.set(t, rows);
      commits += 1;
    },
    snapshot() {
      const out: Record<string, string[]> = {};
      for (const [table, rows] of tables) out[table] = [...rows.keys()].sort();
      return out;
    },
  };
  return sink;
}
