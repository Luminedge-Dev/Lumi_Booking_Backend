// Stage 14 -- the write boundary, as a type only. The pipeline depends on this
// interface; the PostgreSQL implementation lives in ./loader.ts and is only
// ever imported in load mode (dry-run and reconcile never construct a client).

import type { SourceEntity, TableRows } from "../common";
import type { CursorToken } from "../extract/source";

export interface CommitBatch {
  entity: SourceEntity;
  /** Canonical ids of every source document in the batch (accepted or not). The loader replaces these. */
  rootIds: string[];
  rows: TableRows;
  token: CursorToken;
}

export interface RowSink {
  /** Atomically replaces everything the batch's root ids own. Rejects without partial state. */
  commit(batch: CommitBatch): Promise<void>;
}
