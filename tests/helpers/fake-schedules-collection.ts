import { ObjectId } from "mongodb";

export interface FakeScheduleDoc extends Record<string, unknown> {
  _id: ObjectId;
}

type Filter = Record<string, unknown>;

interface FakeScheduleCursor {
  sort: (spec: Record<string, 1 | -1>) => FakeScheduleCursor;
  skip: (n: number) => FakeScheduleCursor;
  limit: (n: number) => FakeScheduleCursor;
  maxTimeMS: (n: number) => FakeScheduleCursor;
  toArray: () => Promise<FakeScheduleDoc[]>;
}

// Minimal in-memory fake standing in for the real MongoDB `schedules`
// collection -- enough Mongo-shaped behavior (insertOne/find/countDocuments/
// deleteOne, plus the two specific aggregate() pipelines
// routes/schedule.routes.js actually issues) for both the legacy
// characterization tests and the native Schedule module's repository/parity
// tests, nothing more. Shared so both exercise identical fake-data semantics
// (same pattern as fake-users-collection.ts).
//
// The two aggregate() pipelines this fake must emulate are structurally
// distinct and detected by shape, not by a generic Mongo aggregation engine:
//   1. getMaxSlotIdAcrossDocs (schedule.routes.js:27-56): $match + $unwind +
//      ... + $group max -- identified by the presence of a $unwind stage.
//   2. the daily-read pipeline (schedule.routes.js:131-161): $match +
//      $addFields _slotIdNum + $sort + $project strip -- no $unwind.
export class FakeSchedulesCollection {
  constructor(private docs: FakeScheduleDoc[] = []) {}

  private matches(doc: FakeScheduleDoc, filter: Filter): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      const docValue = doc[key];
      if (cond instanceof ObjectId) {
        return docValue instanceof ObjectId && docValue.equals(cond);
      }
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        // Supports the operators the two Stage 9 target queries actually
        // use: $ne (daily/monthly Cancelled exclusion), $gte/$lt (the new
        // monthly route's string-boundary range match). Not a general Mongo
        // query engine -- only what routes/schedule.routes.js and the new
        // monthly contract actually issue.
        const condObj = cond as Filter;
        return Object.entries(condObj).every(([op, opValue]) => {
          switch (op) {
            case "$ne":
              return docValue !== opValue;
            case "$gte":
              return (docValue as string) >= (opValue as string);
            case "$gt":
              return (docValue as string) > (opValue as string);
            case "$lte":
              return (docValue as string) <= (opValue as string);
            case "$lt":
              return (docValue as string) < (opValue as string);
            default:
              return false;
          }
        });
      }
      return docValue === cond;
    });
  }

  async insertOne(doc: FakeScheduleDoc): Promise<{ insertedId: ObjectId; acknowledged: true }> {
    const _id = (doc._id as ObjectId | undefined) ?? new ObjectId();
    this.docs.push({ ...doc, _id });
    return { insertedId: _id, acknowledged: true };
  }

  // Zero-arg form: returns the raw backing array directly (test-fixture
  // inspection, mirroring FakeUsersCollection's existing convention).
  // With-filter form: returns a cursor-shaped object supporting the exact
  // chain GET /admin/get-schedules uses --
  // .find(q).sort({_id:-1}).skip(n).limit(n).maxTimeMS(n).toArray() -- and
  // the simpler .find({userId}).toArray() chain /schedule/:userId uses.
  find(): FakeScheduleDoc[];
  find(filter: Filter): FakeScheduleCursor;
  find(filter?: Filter): FakeScheduleDoc[] | FakeScheduleCursor {
    if (filter === undefined) return this.docs;
    let result = this.docs.filter((d) => this.matches(d, filter));

    const cursor: FakeScheduleCursor = {
      sort(spec: Record<string, 1 | -1>) {
        const [[key, dir]] = Object.entries(spec);
        result = [...result].sort((a, b) => {
          const av = a[key] as unknown;
          const bv = b[key] as unknown;
          if (av === bv) return 0;
          return (av! > bv! ? 1 : -1) * dir;
        });
        return cursor;
      },
      skip(n: number) {
        result = result.slice(n);
        return cursor;
      },
      limit(n: number) {
        result = result.slice(0, n);
        return cursor;
      },
      maxTimeMS(_n: number) {
        return cursor;
      },
      toArray: async () => result,
    };
    return cursor;
  }

  async countDocuments(filter: Filter = {}, _options?: { maxTimeMS?: number }): Promise<number> {
    return this.docs.filter((d) => this.matches(d, filter)).length;
  }

  async deleteOne(filter: Filter): Promise<{ deletedCount: number }> {
    const idx = this.docs.findIndex((d) => this.matches(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    this.docs.splice(idx, 1);
    return { deletedCount: 1 };
  }

  aggregate(pipeline: Array<Record<string, unknown>>, _options?: { maxTimeMS?: number }): { toArray: () => Promise<Array<Record<string, unknown>>> } {
    const hasUnwind = pipeline.some((stage) => "$unwind" in stage);
    if (hasUnwind) {
      return { toArray: async () => this.runMaxSlotIdPipeline(pipeline) };
    }
    return { toArray: async () => this.runDailyReadPipeline(pipeline) };
  }

  private matchStageOf(pipeline: Array<Record<string, unknown>>): Filter {
    const stage = pipeline.find((s) => "$match" in s);
    return (stage?.$match as Filter) ?? {};
  }

  private slotIdToInt(rawSlotId: unknown): number {
    const n = parseInt(String(rawSlotId), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Emulates getMaxSlotIdAcrossDocs: $match key -> $unwind timeSlots ->
  // coerce timeSlots.slotId to int -> $group max -- returns [{maxId}] or [].
  private runMaxSlotIdPipeline(pipeline: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const matchStage = this.matchStageOf(pipeline);
    const matched = this.docs.filter((d) => this.matches(d, matchStage));
    let maxId = 0;
    let any = false;
    for (const doc of matched) {
      const slots = (doc.timeSlots as Array<Record<string, unknown>> | undefined) ?? [];
      for (const slot of slots) {
        any = true;
        const n = this.slotIdToInt(slot?.slotId);
        if (n > maxId) maxId = n;
      }
    }
    return any ? [{ maxId }] : [];
  }

  // Emulates the daily-read pipeline: $match -> compute _slotIdNum from
  // timeSlots[0].slotId -> sort {_slotIdNum:1, startDate:1, _id:1} ->
  // strip _slotIdNum.
  private runDailyReadPipeline(pipeline: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const matchStage = this.matchStageOf(pipeline);
    const matched: Array<FakeScheduleDoc & { _slotIdNum: number }> = this.docs
      .filter((d) => this.matches(d, matchStage))
      .map((d): FakeScheduleDoc & { _slotIdNum: number } => {
        const slots = (d.timeSlots as Array<Record<string, unknown>> | undefined) ?? [];
        const first = slots[0];
        const _slotIdNum = first ? this.slotIdToInt(first.slotId) : 0;
        return { ...d, _slotIdNum };
      });

    matched.sort((a, b) => {
      if (a._slotIdNum !== b._slotIdNum) return a._slotIdNum - b._slotIdNum;
      const aStart = String(a.startDate);
      const bStart = String(b.startDate);
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      const aId = String(a._id);
      const bId = String(b._id);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });

    return matched.map(({ _slotIdNum, ...rest }) => rest);
  }
}
