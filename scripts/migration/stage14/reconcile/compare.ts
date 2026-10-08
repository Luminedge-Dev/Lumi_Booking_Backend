// Stage 14 -- reconciliation math (pure; no I/O).
//
// Compares the EXPECTED state of one table (derived from the source) with the
// ACTUAL state read back from PostgreSQL, and attributes every difference.
//
// A difference is "explained" ONLY when the previous load manifest proves the
// SOURCE changed after that load (a new row, a removed/now-quarantined row, a
// modified row). Anything else is "unexplained", and any unexplained
// difference blocks the verdict -- zero tolerance.

export type DigestMap = ReadonlyMap<string, string>;

export interface TableComparison {
  expected: number;
  target: number;
  /** In expected, absent from target. */
  missingInTarget: string[];
  /** In target, absent from expected. */
  unexpectedInTarget: string[];
  /** In both, different content digest. */
  digestMismatch: string[];
  /** Differences proven to be source drift since the previous load manifest. */
  explainedDrift: number;
  unexplained: number;
}

export function compareTable(expected: DigestMap, target: DigestMap, previous?: Readonly<Record<string, string>>): TableComparison {
  const missingInTarget: string[] = [];
  const unexpectedInTarget: string[] = [];
  const digestMismatch: string[] = [];
  let explainedDrift = 0;
  let unexplained = 0;

  for (const [key, digest] of expected) {
    const actual = target.get(key);
    if (actual === undefined) {
      missingInTarget.push(key);
      // New in the source since the previous load => the load could not have had it.
      if (previous && previous[key] === undefined) explainedDrift += 1;
      else unexplained += 1;
    } else if (actual !== digest) {
      digestMismatch.push(key);
      // The source row changed since the load => target still equals the OLD digest.
      if (previous && previous[key] === actual) explainedDrift += 1;
      else unexplained += 1;
    }
  }
  for (const [key, digest] of target) {
    if (expected.has(key)) continue;
    unexpectedInTarget.push(key);
    // Removed from / now quarantined in the source since the load => target equals the OLD row.
    if (previous && previous[key] === digest) explainedDrift += 1;
    else unexplained += 1;
  }

  return {
    expected: expected.size,
    target: target.size,
    missingInTarget: missingInTarget.sort(),
    unexpectedInTarget: unexpectedInTarget.sort(),
    digestMismatch: digestMismatch.sort(),
    explainedDrift,
    unexplained,
  };
}

/** Per-kind ledger equation, used as a standalone reconciliation line. */
export function ledgerEquation(line: { source: number; accepted: number; quarantined: number; skipped: number }): {
  balanced: boolean;
  delta: number;
} {
  const delta = line.source - (line.accepted + line.quarantined + line.skipped);
  return { balanced: delta === 0, delta };
}