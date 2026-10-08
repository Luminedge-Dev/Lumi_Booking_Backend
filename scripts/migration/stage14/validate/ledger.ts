// Stage 14 -- the accounting ledger.
//
// Core invariant, per kind (a root table or a child table):
//
//     source  =  accepted  +  quarantined  +  skipped
//
// `source` is counted independently from the RAW documents; `accepted` and
// `quarantined` come from the transform. `skipped` is reserved for explicitly
// approved skips and is ALWAYS 0 in Stage 14 (no skip has been approved), so
// nothing can disappear without a reason code.
//
// `committed` tracks rows actually written to PostgreSQL in load mode and must
// end equal to `accepted`.

import { TABLES, type AggregateResult, type QuarantineEntry, type SourceEntity, type TableName } from "../common";

export interface LedgerLine {
  source: number;
  accepted: number;
  quarantined: number;
  /** quarantined only because their parent document was withheld (subset of `quarantined`). */
  parentQuarantined: number;
  skipped: number;
  committed: number;
}

export const ROOT_TABLE: Record<SourceEntity, TableName> = {
  users: "users",
  courses: "courses",
  schedules: "schedules",
  bookingMock: "bookings",
};

export class LedgerImbalanceError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly kind: string,
    detail: string
  ) {
    super(`ledger imbalance for ${kind} (${sourceId}): ${detail}`);
  }
}

function emptyLine(): LedgerLine {
  return { source: 0, accepted: 0, quarantined: 0, parentQuarantined: 0, skipped: 0, committed: 0 };
}

export class Ledger {
  private readonly lines = new Map<TableName, LedgerLine>(TABLES.map((t) => [t, emptyLine()]));
  readonly extracted: Record<SourceEntity, number> = { users: 0, courses: 0, schedules: 0, bookingMock: 0 };

  line(kind: TableName): LedgerLine {
    return this.lines.get(kind)!;
  }

  /** Folds one aggregate into the ledger and proves it balances on its own. */
  record(result: AggregateResult): QuarantineEntry[] {
    const root = ROOT_TABLE[result.entity];
    const entries: QuarantineEntry[] = [];
    this.extracted[result.entity] += 1;
    this.line(root).source += 1;
    for (const [kind, n] of Object.entries(result.sourceUnits) as Array<[TableName, number]>) {
      this.line(kind).source += n;
    }

    if (result.rootQuarantine) {
      this.line(root).quarantined += 1;
      entries.push(result.rootQuarantine);
      for (const [kind, n] of Object.entries(result.sourceUnits) as Array<[TableName, number]>) {
        this.line(kind).quarantined += n;
        this.line(kind).parentQuarantined += n;
      }
      return entries;
    }

    const rows = result.rows ?? {};
    const perKindAccepted = new Map<TableName, number>();
    for (const table of TABLES) {
      const n = rows[table]?.length ?? 0;
      if (n > 0) perKindAccepted.set(table, n);
    }
    if ((perKindAccepted.get(root) ?? 0) !== 1) {
      throw new LedgerImbalanceError(result.sourceId, root, "accepted aggregate did not produce exactly one root row");
    }
    for (const [kind, n] of perKindAccepted) this.line(kind).accepted += n;

    const perKindQuarantined = new Map<TableName, number>();
    for (const q of result.childQuarantines) {
      this.line(q.kind).quarantined += q.units;
      perKindQuarantined.set(q.kind, (perKindQuarantined.get(q.kind) ?? 0) + q.units);
      entries.push(q);
    }

    for (const kind of TABLES) {
      if (kind === root) continue;
      const expected = result.sourceUnits[kind] ?? 0;
      const got = (perKindAccepted.get(kind) ?? 0) + (perKindQuarantined.get(kind) ?? 0);
      if (expected !== got) {
        throw new LedgerImbalanceError(result.sourceId, kind, `source units ${expected} != accepted+quarantined ${got}`);
      }
    }
    return entries;
  }

  noteCommitted(rows: Partial<Record<TableName, unknown[]>>): void {
    for (const table of TABLES) this.line(table).committed += rows[table]?.length ?? 0;
  }

  unbalanced(): Array<{ kind: TableName; line: LedgerLine }> {
    const out: Array<{ kind: TableName; line: LedgerLine }> = [];
    for (const kind of TABLES) {
      const l = this.line(kind);
      if (l.source !== l.accepted + l.quarantined + l.skipped) out.push({ kind, line: { ...l } });
    }
    return out;
  }

  snapshot(): Record<TableName, LedgerLine> {
    return Object.fromEntries(TABLES.map((t) => [t, { ...this.line(t) }])) as Record<TableName, LedgerLine>;
  }
}
