// Stage 14 -- the EXPECTED target state, derived purely from the source.
//
// For every row the transform accepts we remember (primary key -> content
// digest). After a load -- or on a later, independent run -- the actual
// PostgreSQL contents are digested the same way and compared against this map.
// Holds only keys and 16-hex digests, never row values.

import { TABLES, shortDigest, type Row, type TableName, type TableRows } from "../common";
import { rowDigest, rowKey, unknownColumns } from "../columns";

export type TableManifest = Record<TableName, Record<string, string>>;

export class DuplicatePrimaryKeyError extends Error {
  constructor(table: string, key: string) {
    super(`transform produced two rows with the same primary key for ${table}: ${key}`);
  }
}

export class UnknownColumnError extends Error {
  constructor(table: string, columns: string[]) {
    super(`transform produced columns unknown to ${table}: ${columns.join(", ")}`);
  }
}

export class ExpectationCollector {
  private readonly tables = new Map<TableName, Map<string, string>>(TABLES.map((t) => [t, new Map()]));

  add(rows: TableRows): void {
    for (const table of TABLES) {
      for (const row of rows[table] ?? []) this.addRow(table, row);
    }
  }

  private addRow(table: TableName, row: Row): void {
    const extra = unknownColumns(table, row);
    if (extra.length > 0) throw new UnknownColumnError(table, extra);
    const key = rowKey(table, row);
    const map = this.tables.get(table)!;
    if (map.has(key)) throw new DuplicatePrimaryKeyError(table, key);
    map.set(key, rowDigest(table, row));
  }

  count(table: TableName): number {
    return this.tables.get(table)!.size;
  }

  entries(table: TableName): ReadonlyMap<string, string> {
    return this.tables.get(table)!;
  }

  toManifest(): TableManifest {
    const out = {} as TableManifest;
    for (const table of TABLES) {
      out[table] = Object.fromEntries([...this.tables.get(table)!.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return out;
  }

  /** One order-independent fingerprint per table (proves two runs are identical). */
  fingerprints(): Record<TableName, string> {
    const out = {} as Record<TableName, string>;
    for (const table of TABLES) {
      const sorted = [...this.tables.get(table)!.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      out[table] = `${sorted.length}:${shortDigest(sorted.map(([k, d]) => `${k}=${d}`).join("|"))}`;
    }
    return out;
  }
}
