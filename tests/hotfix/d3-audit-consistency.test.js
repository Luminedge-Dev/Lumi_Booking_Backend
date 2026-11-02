"use strict";

/**
 * D3-R10 to D3-R13 corrective tests — audit counting accuracy, read-only
 * collection safety and complete physical schedule scanning (Day-3 audit
 * corrections, 29 Oct 2026).
 *
 *   D3-R10  one over-capacity slot could be recorded twice (once during slot
 *           validation and again during the booking comparison), inflating
 *           `capacityMismatches`, `confirmedIntegrityErrors` and
 *           `cancellationBlockedSlots`.
 *   D3-R11  the read-only collection wrapper permitted `aggregate()`, which can
 *           execute write-capable `$out` / `$merge` stages.
 *   D3-R12  that wrapper was a Proxy over the real collection, so reflection
 *           (`Reflect.ownKeys`, `getOwnPropertyDescriptors`), private symbols and
 *           prototype walking could still reach driver internals.
 *   D3-R13  the schedule map was keyed by schedule id, so two schedules sharing a
 *           missing or duplicated `_id` overwrote each other and one schedule's
 *           slots escaped capacity analysis (and bookings could be attributed
 *           arbitrarily).
 *
 * These are PURE UNIT tests: the audit is exercised against in-memory stub
 * collections, so this file needs neither a replica set nor
 * `HOTFIX_TEST_MONGODB_URI`. The database-backed "the audit mutates nothing"
 * proof remains in fix-02-cancellation.test.js (D3-A2).
 *
 * Run:
 *   node --test tests/hotfix/d3-audit-consistency.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  runSeatConsistencyAudit,
  asReadOnlyCollection,
  asReadOnlyCursor,
} = require("../../scripts/audit-seat-consistency");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stand-in for a real collection: only the read path the audit uses. */
function stubCollection(docs) {
  return {
    find: () => ({ toArray: async () => docs.map((doc) => ({ ...doc })) }),
  };
}

const schedule = (id, timeSlots) => ({ _id: id, timeSlots });
const centerBooking = (overrides = {}) => ({
  location: "Test Center",
  status: "pending",
  ...overrides,
});

async function audit({ schedules, bookings, sampleLimit = 10 }) {
  return runSeatConsistencyAudit({
    bookingMockCollection: stubCollection(bookings),
    schedulesCollection: stubCollection(schedules),
    sampleLimit,
  });
}

// ---------------------------------------------------------------------------
// D3-R10 — capacity counting accuracy
// ---------------------------------------------------------------------------

test("D3-R10a an over-capacity slot is counted once, not once per evaluation pass", async () => {
  const report = await audit({
    schedules: [schedule("s1", [{ slotId: "1", slot: 6, totalSlot: 5 }])],
    bookings: [],
  });

  assert.equal(report.issueCounts.capacityMismatches, 1, "one affected slot");
  assert.equal(report.issues.capacityMismatches.length, 1, "one sampled entry");
  assert.equal(report.summary.capacityErrors, 1);
  assert.equal(report.summary.capacityWarnings, 0);
  assert.equal(report.summary.cancellationBlockedSlots, 1);
  assert.equal(report.summary.uncertainDiscrepancies, 0);
  // The single fault must not be double-counted into confirmedIntegrityErrors.
  assert.equal(report.summary.confirmedIntegrityErrors, 1);

  const entry = report.issues.capacityMismatches[0];
  assert.equal(entry.kind, "availability-above-capacity");
  assert.equal(entry.severity, "error");
  assert.equal(entry.blocksCancellation, true);
  assert.equal(entry.slotIndex, 0, "the physical index identifies the slot");
});

test("D3-R10b an over-capacity slot with an active booking is still counted once", async () => {
  const report = await audit({
    schedules: [schedule("s1", [{ slotId: "1", slot: 6, totalSlot: 5 }])],
    bookings: [centerBooking({ scheduleId: "s1", slotId: "1" })],
  });

  assert.equal(report.issueCounts.capacityMismatches, 1, "the booking must not add a second entry");
  assert.equal(report.summary.capacityErrors, 1);
  assert.equal(report.summary.cancellationBlockedSlots, 1);
  assert.equal(report.summary.confirmedIntegrityErrors, 1);
});

test("D3-R10c separate affected slots are counted independently", async () => {
  const report = await audit({
    schedules: [
      schedule("sA", [
        { slotId: "1", slot: 6, totalSlot: 5 }, // above capacity -> error
        { slotId: "2", slot: 0, totalSlot: 4 }, // drift -> warning (expected 4)
      ]),
      schedule("sB", [{ slotId: "1", slot: 2, totalSlot: 3 }]), // drift -> warning (expected 3)
    ],
    bookings: [],
  });

  assert.equal(report.issueCounts.capacityMismatches, 3, "each distinct slot once");
  assert.equal(report.summary.capacityErrors, 1);
  assert.equal(report.summary.capacityWarnings, 2);
  assert.equal(report.summary.uncertainDiscrepancies, 2);
  assert.equal(report.summary.confirmedIntegrityErrors, 1);
  assert.equal(report.summary.cancellationBlockedSlots, 1, "only sA/1 is at or above capacity");
});

test("D3-R10d availability equal to capacity with an active booking blocks cancellation without inflating errors", async () => {
  const report = await audit({
    schedules: [schedule("s1", [{ slotId: "1", slot: 5, totalSlot: 5 }])],
    bookings: [centerBooking({ scheduleId: "s1", slotId: "1" })],
  });

  assert.equal(report.issueCounts.capacityMismatches, 1);
  assert.equal(report.summary.capacityErrors, 0, "at-capacity is drift, not a structural error");
  assert.equal(report.summary.capacityWarnings, 1);
  assert.equal(report.summary.cancellationBlockedSlots, 1, "the slot is at capacity, so it blocks");
  assert.equal(report.summary.confirmedIntegrityErrors, 0);
  assert.equal(report.summary.uncertainDiscrepancies, 1);

  const entry = report.issues.capacityMismatches[0];
  assert.equal(entry.availableSeats, 5);
  assert.equal(entry.expectedAvailable, 4);
  assert.equal(entry.blocksCancellation, true);
});

test("D3-R10e an unusable counter is a structural finding, never a capacity mismatch", async () => {
  const report = await audit({
    schedules: [
      schedule("s1", [
        { slotId: "1", slot: "6", totalSlot: 5 }, // numeric string: refused
        { slotId: "2", slot: 2 }, // totalSlot missing: no invented default
      ]),
    ],
    bookings: [],
  });

  assert.equal(report.issueCounts.invalidSlotRecords, 2);
  assert.equal(report.issueCounts.capacityMismatches, 0, "unusable counters get no capacity verdict");
  assert.equal(report.summary.cancellationBlockedSlots, 0);
  assert.equal(report.summary.confirmedIntegrityErrors, 2);
});

test("D3-R10f duplicate slotIds do not collapse separate physical slots", async () => {
  const report = await audit({
    schedules: [
      schedule("s1", [
        { slotId: "7", slot: 9, totalSlot: 3 }, // over capacity, physical index 0
        { slotId: "7", slot: 8, totalSlot: 3 }, // over capacity, physical index 1
      ]),
    ],
    bookings: [],
  });

  assert.equal(report.issueCounts.duplicateSlotIds, 1, "the duplicate id is reported once");
  assert.equal(
    report.issueCounts.capacityMismatches,
    2,
    "each physical slot gets its own over-capacity verdict"
  );
  assert.equal(report.summary.capacityErrors, 2);
  assert.equal(report.summary.cancellationBlockedSlots, 2);
  assert.deepEqual(
    report.issues.capacityMismatches.map((m) => m.slotIndex).sort(),
    [0, 1],
    "the physical index disambiguates the two slots"
  );
});

test("D3-R10g a sampleLimit smaller than the issue count preserves exact totals", async () => {
  const slots = Array.from({ length: 5 }, (_, i) => ({
    slotId: String(i + 1),
    slot: 9,
    totalSlot: 5,
  }));

  const report = await audit({
    schedules: [schedule("s1", slots)],
    bookings: [],
    sampleLimit: 2,
  });

  assert.equal(report.issueCounts.capacityMismatches, 5, "exact total, not the sample size");
  assert.equal(report.issues.capacityMismatches.length, 2, "samples capped at sampleLimit");
  assert.equal(report.summary.capacityErrors, 5);
  assert.equal(report.summary.cancellationBlockedSlots, 5);
  assert.equal(report.summary.sampledAt, 2);
});

test("D3-R10h confirmedIntegrityErrors counts occurrences; uncertainDiscrepancies counts drift", async () => {
  const report = await audit({
    schedules: [
      schedule("s1", [
        { slotId: "1", slot: 6, totalSlot: 5 }, // over capacity -> error
        { slotId: "2", slot: 1, totalSlot: 5 }, // drift -> warning
        { slotId: "3", slot: 7 }, // invalid counter -> structural
        { slotId: "3", slot: 2, totalSlot: 4 }, // duplicate slotId -> structural
      ]),
    ],
    bookings: [
      centerBooking({ scheduleId: "s1", slotId: "1" }),
      centerBooking({ scheduleId: "missing", slotId: "1" }), // schedule not found
      { location: "Online", status: "pending" }, // unrecognised location
    ],
  });

  // invalidSlotRecords 1 + duplicateSlotIds 1 + unlinkable 1 + ambiguous 0 +
  // unrecognised 1 + capacity errors 1 = 5
  assert.equal(report.summary.confirmedIntegrityErrors, 5);
  assert.equal(report.summary.uncertainDiscrepancies, 1);
  assert.equal(report.summary.cancellationBlockedSlots, 1);
  assert.equal(typeof report.metricSemantics.confirmedIntegrityErrors, "string");
});

test("D3-R10i a slot whose availability equals capacity minus active bookings is never flagged", async () => {
  const report = await audit({
    schedules: [schedule("s1", [{ slotId: "1", slot: 3, totalSlot: 5 }])],
    bookings: [
      centerBooking({ scheduleId: "s1", slotId: "1" }),
      centerBooking({ scheduleId: "s1", slotId: "1" }),
      // Cancelled rows must not count towards capacity.
      centerBooking({ scheduleId: "s1", slotId: "1", status: "cancelled" }),
    ],
  });

  assert.equal(report.issueCounts.capacityMismatches, 0);
  assert.equal(report.summary.cancellationBlockedSlots, 0);
  assert.equal(report.summary.confirmedIntegrityErrors, 0);
});

// ---------------------------------------------------------------------------
// D3-R11 — write operations are unreachable
// ---------------------------------------------------------------------------

test("D3-R11a write-capable aggregation is unavailable and never reaches the driver", () => {
  let aggregateCalls = 0;
  const stub = {
    find: () => ({ toArray: async () => [] }),
    aggregate: () => {
      aggregateCalls += 1;
      return "should-never-run";
    },
  };
  const wrapped = asReadOnlyCollection(stub, "schedules");

  // D3-R12: a non-exposed method is simply absent — the facade does not wrap the
  // real collection in a Proxy, so `aggregate` has no route to the driver at all.
  assert.equal(wrapped.aggregate, undefined, "aggregate must not be exposed");
  assert.throws(() => wrapped.aggregate([{ $out: "target" }]), TypeError, "$out must fail");
  assert.throws(() => wrapped.aggregate([{ $merge: "target" }]), TypeError, "$merge must fail");
  assert.equal(aggregateCalls, 0, "the underlying aggregate must never be invoked");
});

test("D3-R11b every write method is absent and never reaches the driver", () => {
  const calls = [];
  const stub = {
    find: () => ({ toArray: async () => [] }),
    insertOne: () => calls.push("insertOne"),
    updateOne: () => calls.push("updateOne"),
    deleteMany: () => calls.push("deleteMany"),
    drop: () => calls.push("drop"),
  };
  const wrapped = asReadOnlyCollection(stub, "bookingMock");

  for (const method of ["insertOne", "updateOne", "deleteMany", "drop"]) {
    assert.equal(wrapped[method], undefined, `${method} must be absent`);
    assert.throws(() => wrapped[method]({}), TypeError, `${method} call must fail`);
  }
  assert.deepEqual(calls, [], "no write method may reach the underlying collection");
});

test("D3-R11c only find() is exposed, the underlying handle is withheld, and the wrapper is not thenable", () => {
  const stub = {
    find: () => ({ toArray: async () => [] }),
    findOne: () => "read!",
    aggregate: () => "read!",
    insertOne: () => "write!",
    collectionName: "bookingMock",
    db: { collection: () => "real-db" },
    client: { db: () => "real-client" },
  };
  const wrapped = asReadOnlyCollection(stub, "bookingMock");

  assert.equal(typeof wrapped.find, "function", "find must remain reachable");
  assert.equal(wrapped.db, undefined, "the database handle must not leak");
  assert.equal(wrapped.client, undefined, "the client must not leak");
  assert.equal(wrapped.collectionName, undefined, "collection state must not leak");
  assert.equal(wrapped.then, undefined, "the wrapper must never look thenable");
});

test("D3-R11d the wrapper still supports the working find() the audit relies on", async () => {
  const docs = [{ slotId: "1", slot: 2, totalSlot: 3 }];
  const wrapped = asReadOnlyCollection(stubCollection(docs), "schedules");

  const rows = await wrapped.find({ count: 1 }).toArray();
  assert.deepEqual(rows, docs);
});

// ---------------------------------------------------------------------------
// D3-R12 — reflection / symbol / prototype surface
// ---------------------------------------------------------------------------

test("D3-R12a reflection cannot reveal the raw collection or its prototype", () => {
  const raw = {
    find: () => ({ toArray: async () => [] }),
    db: { collection: () => "raw-db" },
    client: { db: () => "raw-client" },
    collectionName: "bookingMock",
  };
  const wrapped = asReadOnlyCollection(raw, "bookingMock");

  assert.equal(Object.getPrototypeOf(wrapped), null, "the facade must have no prototype");
  assert.equal(Object.getOwnPropertyDescriptor(wrapped, "db"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(wrapped, "client"), undefined);
  assert.deepEqual(Object.getOwnPropertyNames(wrapped), ["find"], "only find is an own name");
  assert.deepEqual(Object.getOwnPropertyDescriptors(wrapped) && Object.keys(Object.getOwnPropertyDescriptors(wrapped)), ["find"]);
  assert.deepEqual(Reflect.ownKeys(wrapped), ["find"], "no hidden members");
  assert.equal("db" in wrapped, false);
  assert.equal(wrapped.db, undefined);
  assert.equal(wrapped.client, undefined);
  assert.equal(wrapped.collectionName, undefined);
  assert.equal(wrapped.constructor, undefined, "no Object constructor via the prototype");
});

test("D3-R12b private symbols on the raw collection never leak through the facade", () => {
  const secret = Symbol("kPrivateCollectionState");
  const raw = {
    find: () => ({ toArray: async () => [] }),
    [secret]: { db: "raw-db", client: "raw-client" },
  };
  const wrapped = asReadOnlyCollection(raw, "bookingMock");

  assert.deepEqual(Object.getOwnPropertySymbols(wrapped), [], "no symbols are re-exported");
  assert.equal(wrapped[secret], undefined, "symbol lookup cannot reach the raw collection");
  assert.equal(Object.getOwnPropertyDescriptor(wrapped, secret), undefined);
});

test("D3-R12c the facade cannot be mutated through assignment, deletion or redefinition", () => {
  const wrapped = asReadOnlyCollection({ find: () => ({ toArray: async () => [] }) }, "stub");

  assert.throws(() => {
    wrapped.find = () => "hacked";
  }, TypeError, "assignment must fail");
  assert.throws(() => {
    delete wrapped.find;
  }, TypeError, "deletion must fail");
  assert.throws(
    () => Object.defineProperty(wrapped, "find", { value: "hacked" }),
    TypeError,
    "redefinition must fail"
  );
  assert.throws(
    () => Object.defineProperty(wrapped, "evil", { value: "hacked" }),
    TypeError,
    "extending the facade must fail"
  );
  assert.throws(() => Object.setPrototypeOf(wrapped, {}), TypeError, "prototype must be fixed");

  assert.equal(Object.isFrozen(wrapped), true);
  assert.equal(typeof wrapped.find, "function", "the interface is unchanged");
  assert.deepEqual(Object.keys(wrapped), ["find"]);
});

test("D3-R12d every non-find operation is absent and never invoked on the driver", () => {
  const calls = [];
  const spy = (name) => () => {
    calls.push(name);
    return "should-never-run";
  };
  const raw = {
    find: () => ({ toArray: async () => [] }),
    findOne: spy("findOne"),
    aggregate: spy("aggregate"),
    countDocuments: spy("countDocuments"),
    distinct: spy("distinct"),
    insertOne: spy("insertOne"),
    insertMany: spy("insertMany"),
    updateOne: spy("updateOne"),
    updateMany: spy("updateMany"),
    replaceOne: spy("replaceOne"),
    deleteOne: spy("deleteOne"),
    deleteMany: spy("deleteMany"),
    findOneAndUpdate: spy("findOneAndUpdate"),
    findOneAndDelete: spy("findOneAndDelete"),
    bulkWrite: spy("bulkWrite"),
    drop: spy("drop"),
    rename: spy("rename"),
    createIndex: spy("createIndex"),
  };
  const wrapped = asReadOnlyCollection(raw, "schedules");

  for (const method of Object.keys(raw)) {
    if (method === "find") continue;
    assert.equal(wrapped[method], undefined, `${method} must be absent`);
    assert.throws(() => wrapped[method]({}), TypeError, `${method} call must fail`);
  }
  assert.deepEqual(calls, [], "no operation other than find may reach the collection");
});

test("D3-R12e the cursor facade exposes only toArray and never the raw cursor", async () => {
  const rawCursor = {
    toArray: async () => [{ ok: 1 }],
    next: () => "raw",
    close: () => "raw",
    client: { db: () => "raw-client" },
    db: { collection: () => "raw-db" },
  };
  const cursor = asReadOnlyCursor(rawCursor, "schedules");

  assert.equal(Object.getPrototypeOf(cursor), null);
  assert.equal(Object.isFrozen(cursor), true);
  assert.deepEqual(Reflect.ownKeys(cursor), ["toArray"], "only toArray is exposed");
  assert.equal(cursor.db, undefined);
  assert.equal(cursor.client, undefined);
  assert.equal(cursor.next, undefined);
  assert.equal(cursor.close, undefined);
  assert.equal(cursor.then, undefined, "the cursor facade must not be thenable");
  assert.deepEqual(await cursor.toArray(), [{ ok: 1 }]);

  // find() hands back the same minimal facade, not the raw driver cursor.
  const wrapped = asReadOnlyCollection({ find: () => rawCursor }, "schedules");
  const returned = wrapped.find();
  assert.equal(Object.getPrototypeOf(returned), null);
  assert.deepEqual(Reflect.ownKeys(returned), ["toArray"]);
  assert.equal(returned.client, undefined);

  // A cursor-like object without toArray is rejected rather than passed through.
  assert.throws(() => asReadOnlyCursor({ next: () => "raw" }, "schedules"), /readable cursor/);
});

test("D3-R12f audit output carries no student personal data", async () => {
  const report = await audit({
    schedules: [schedule("s1", [{ slotId: "1", slot: 1, totalSlot: 2 }])],
    bookings: [
      centerBooking({
        scheduleId: "s1",
        slotId: "1",
        name: "Ada Lovelace",
        email: "ada.lovelace@example.test",
        userId: "student-8844",
        student: "Ada",
      }),
    ],
  });

  const serialized = JSON.stringify(report);
  for (const secret of ["Ada Lovelace", "ada.lovelace@example.test", "student-8844"]) {
    assert.equal(serialized.includes(secret), false, `report must not contain ${secret}`);
  }
  assert.equal(serialized.includes('"name"'), false);
  assert.equal(serialized.includes('"email"'), false);
  assert.equal(serialized.includes('"userId"'), false);
});

// ---------------------------------------------------------------------------
// D3-R13 — complete physical schedule scanning
// ---------------------------------------------------------------------------

test("D3-R13a two schedules without _id are both scanned", async () => {
  const report = await audit({
    schedules: [
      { timeSlots: [{ slotId: "1", slot: 1, totalSlot: 2 }] },
      { timeSlots: [{ slotId: "1", slot: 1, totalSlot: 2 }] },
    ],
    bookings: [],
  });

  assert.equal(report.totals.schedulesScanned, 2, "neither schedule may be overwritten");
  assert.equal(report.totals.slotsScanned, 2);
  assert.equal(report.issueCounts.invalidScheduleRecords, 2, "each unidentified schedule is reported");
});

test("D3-R13b two over-capacity slots on unidentified schedules produce two findings", async () => {
  const report = await audit({
    schedules: [
      { timeSlots: [{ slotId: "1", slot: 9, totalSlot: 5 }] },
      { timeSlots: [{ slotId: "1", slot: 8, totalSlot: 5 }] },
    ],
    bookings: [],
  });

  assert.equal(report.issueCounts.capacityMismatches, 2, "each physical slot is evaluated once");
  assert.equal(report.summary.capacityErrors, 2);
  assert.equal(report.summary.cancellationBlockedSlots, 2);
  assert.deepEqual(
    report.issues.capacityMismatches.map((m) => m.scheduleOrdinal).sort(),
    [0, 1],
    "the scan ordinal disambiguates the two schedules"
  );
});

test("D3-R13c two schedules with the same _id are both scanned and the id is reported", async () => {
  const report = await audit({
    schedules: [
      schedule("dup", [{ slotId: "1", slot: 1, totalSlot: 2 }]),
      schedule("dup", [{ slotId: "2", slot: 1, totalSlot: 2 }]),
    ],
    bookings: [],
  });

  assert.equal(report.totals.schedulesScanned, 2);
  assert.equal(report.totals.slotsScanned, 2);
  assert.equal(report.issueCounts.duplicateScheduleIds, 1, "reported once per duplicated id");
  assert.equal(report.issueCounts.invalidScheduleRecords, 0);
  assert.deepEqual(report.issues.duplicateScheduleIds[0].scheduleOrdinals, [0, 1]);
});

test("D3-R13d a booking naming a duplicated schedule id is never attributed to one schedule", async () => {
  const report = await audit({
    schedules: [
      schedule("dup", [{ slotId: "1", slot: 1, totalSlot: 5 }]),
      schedule("dup", [{ slotId: "1", slot: 1, totalSlot: 5 }]),
    ],
    bookings: [centerBooking({ scheduleId: "dup", slotId: "1" })],
  });

  assert.equal(report.issueCounts.duplicateScheduleIds, 1);
  assert.equal(report.issueCounts.ambiguousCenterBookings, 1);
  assert.equal(report.issues.ambiguousCenterBookings[0].reason, "ambiguous-schedule");
  // If the booking had been attributed to either physical schedule, the
  // comparison would have flagged drift (available 1 vs expected 4).
  assert.equal(report.issueCounts.capacityMismatches, 0, "no arbitrary attribution");
});

test("D3-R13e a schedule without _id invents no booking association", async () => {
  const report = await audit({
    schedules: [{ timeSlots: [{ slotId: "1", slot: 1, totalSlot: 5 }] }],
    bookings: [centerBooking({ scheduleId: "", slotId: "1" })],
  });

  assert.equal(report.issueCounts.invalidScheduleRecords, 1);
  assert.equal(report.issueCounts.unlinkableCenterBookings, 1);
  assert.equal(
    report.issues.unlinkableCenterBookings[0].reason,
    "missing-schedule-or-slot-reference"
  );
  assert.equal(report.issueCounts.capacityMismatches, 0, "no invented association");
});

test("D3-R13f two distinct identified schedules keep independent booking counts", async () => {
  const report = await audit({
    schedules: [
      schedule("A", [{ slotId: "1", slot: 3, totalSlot: 5 }]),
      schedule("B", [{ slotId: "1", slot: 2, totalSlot: 5 }]),
    ],
    bookings: [
      centerBooking({ scheduleId: "A", slotId: "1" }),
      centerBooking({ scheduleId: "B", slotId: "1" }),
      centerBooking({ scheduleId: "B", slotId: "1" }),
    ],
  });

  assert.equal(report.issueCounts.capacityMismatches, 2);
  const byRef = new Map(report.issues.capacityMismatches.map((m) => [m.scheduleRef, m]));
  assert.equal(byRef.get("A").activeBookings, 1, "A counts only its own booking");
  assert.equal(byRef.get("A").expectedAvailable, 4);
  assert.equal(byRef.get("B").activeBookings, 2, "B counts only its own bookings");
  assert.equal(byRef.get("B").expectedAvailable, 3);
});

test("D3-R13g duplicate slotIds on unidentified schedules keep distinct physical identities", async () => {
  const report = await audit({
    schedules: [
      { timeSlots: [{ slotId: "7", slot: 9, totalSlot: 3 }] },
      { timeSlots: [{ slotId: "7", slot: 9, totalSlot: 3 }] },
    ],
    bookings: [],
  });

  assert.equal(report.issueCounts.invalidScheduleRecords, 2);
  assert.equal(report.issueCounts.capacityMismatches, 2, "one verdict per physical slot");
  assert.deepEqual(
    report.issues.capacityMismatches.map((m) => `${m.scheduleOrdinal}:${m.slotIndex}`).sort(),
    ["0:0", "1:0"],
    "ordinal plus index is a globally unique slot identity"
  );
});

test("D3-R13h a sampleLimit smaller than the findings preserves exact totals", async () => {
  const report = await audit({
    schedules: [
      { timeSlots: [{ slotId: "1", slot: 9, totalSlot: 5 }] },
      { timeSlots: [{ slotId: "1", slot: 9, totalSlot: 5 }] },
      schedule("dup", [{ slotId: "1", slot: 1, totalSlot: 5 }]),
      schedule("dup", [{ slotId: "1", slot: 1, totalSlot: 5 }]),
    ],
    bookings: [centerBooking({ scheduleId: "dup", slotId: "1" })],
    sampleLimit: 1,
  });

  assert.equal(report.issueCounts.invalidScheduleRecords, 2, "exact total");
  assert.equal(report.issueCounts.duplicateScheduleIds, 1);
  assert.equal(report.issueCounts.capacityMismatches, 2);
  assert.equal(report.issueCounts.ambiguousCenterBookings, 1);
  assert.equal(report.issues.capacityMismatches.length, 1, "samples capped");
  assert.equal(report.issues.invalidScheduleRecords.length, 1, "samples capped");
  assert.equal(report.summary.sampledAt, 1);
  // invalidSchedule 2 + duplicateSchedule 1 + ambiguous booking 1 + capacity errors 2 = 6
  assert.equal(report.summary.confirmedIntegrityErrors, 6);
});

test("D3-R13i the audit only ever calls find() on the supplied collections", async () => {
  const touched = [];
  const makeCollection = (docs, label) => ({
    find: () => {
      touched.push(`${label}.find`);
      return { toArray: async () => docs };
    },
    aggregate: () => touched.push(`${label}.aggregate`),
    findOne: () => touched.push(`${label}.findOne`),
    insertOne: () => touched.push(`${label}.insertOne`),
    updateOne: () => touched.push(`${label}.updateOne`),
    deleteMany: () => touched.push(`${label}.deleteMany`),
    drop: () => touched.push(`${label}.drop`),
  });

  await runSeatConsistencyAudit({
    bookingMockCollection: makeCollection([], "bookingMock"),
    schedulesCollection: makeCollection([], "schedules"),
    sampleLimit: 5,
  });

  assert.deepEqual(
    touched.sort(),
    ["bookingMock.find", "schedules.find"],
    "read-only: only find() reaches either collection"
  );
});
