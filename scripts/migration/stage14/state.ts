// Stage 14 -- mutable cross-document state shared by the transforms.
//
// Holds ONLY identifiers and counters (never document bodies), so memory stays
// bounded by the number of IDs (~32k strings), not by document size.

import type { Finding, RawDoc, SourceEntity } from "./common";
import { opaqueGroupKey } from "./common";

export class FindingCollector {
  private readonly counts = new Map<string, number>();

  add(code: string, scope: string, count = 1): void {
    const key = `${scope}\u0000${code}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
  }

  addAll(findings: Finding[]): void {
    for (const f of findings) this.add(f.code, f.scope, f.count);
  }

  toSorted(): Finding[] {
    return [...this.counts.entries()]
      .map(([key, count]) => {
        const [scope, code] = key.split("\u0000");
        return { scope: scope!, code: code!, count };
      })
      .sort((a, b) => (a.scope + a.code).localeCompare(b.scope + b.code));
  }
}

export interface EmailDuplicateGroup {
  groupKey: string;
  memberIds: string[];
}

export class PipelineState {
  /** Canonical ids of EVERY source document, accepted or not (existence). */
  readonly sourceIds: Record<SourceEntity, Set<string>> = {
    users: new Set(),
    courses: new Set(),
    schedules: new Set(),
    bookingMock: new Set(),
  };

  /** Canonical ids accepted for load (parent resolution). */
  readonly acceptedUsers = new Set<string>();
  readonly acceptedCourses = new Set<string>();
  /** scheduleId -> slotIds of ACCEPTED schedules. */
  readonly acceptedSchedules = new Map<string, Set<string>>();
  readonly acceptedBookings = new Set<string>();

  /**
   * True only for --limit smoke samples: parents outside the sample are then
   * unknowable, so parent checks fall back to "exists in source". Never true
   * for a load or reconcile run.
   */
  sampleMode = false;

  private readonly emailBuckets = new Map<string, string[]>();

  readonly findings = new FindingCollector();
  /** scope -> field -> occurrences, for fields no contract declares. */
  readonly undeclaredFields = new Map<string, Map<string, number>>();

  /** Existence index used to resolve *BySchedule map keys (bookingMock ids first, then schedule ids). */
  keyIndex: { bookings: ReadonlySet<string>; schedules: ReadonlySet<string> } = {
    bookings: new Set(),
    schedules: new Set(),
  };

  noteUndeclared(scope: string, doc: RawDoc, declared: ReadonlySet<string>): void {
    for (const field of Object.keys(doc)) {
      if (declared.has(field)) continue;
      let perScope = this.undeclaredFields.get(scope);
      if (!perScope) {
        perScope = new Map();
        this.undeclaredFields.set(scope, perScope);
      }
      perScope.set(field, (perScope.get(field) ?? 0) + 1);
    }
  }

  noteEmail(userId: string, email: string): void {
    const key = email.toLowerCase();
    const bucket = this.emailBuckets.get(key);
    if (bucket) bucket.push(userId);
    else this.emailBuckets.set(key, [userId]);
  }

  /** Case-insensitive duplicate groups. Reported by opaque key + member ids only (no addresses). */
  emailDuplicateGroups(): EmailDuplicateGroup[] {
    const groups: EmailDuplicateGroup[] = [];
    for (const [email, ids] of this.emailBuckets) {
      if (ids.length > 1) groups.push({ groupKey: opaqueGroupKey(email), memberIds: [...ids].sort() });
    }
    return groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
  }

  undeclaredReport(): Array<{ scope: string; field: string; count: number }> {
    const out: Array<{ scope: string; field: string; count: number }> = [];
    for (const [scope, fields] of this.undeclaredFields) {
      for (const [field, count] of fields) out.push({ scope, field, count });
    }
    return out.sort((a, b) => (a.scope + a.field).localeCompare(b.scope + b.field));
  }
}
