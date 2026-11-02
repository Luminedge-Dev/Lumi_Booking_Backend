"use strict";

/**
 * D3-R09 — READ-ONLY seat-consistency audit.
 *
 * Historical context: the pre-existing R07 defect made a Test Center booking
 * decrement the WRONG element of `schedule.timeSlots` (it bound Mongo's
 * positional `$` with two competing predicates, so `timeSlots.0` moved instead
 * of the booked slot). Bookings taken before that fix therefore may have left
 * `timeSlots[].slot` (seats still available) disagreeing with
 * `totalSlot - activeBookings` for the affected slots.
 *
 * This script only *reports*. It never updates, deletes, repairs, migrates or
 * reindexes anything, and it never prints student identity:
 *
 *   - each collection is replaced by a frozen, null-prototype facade exposing
 *     ONLY `find`; the real collection lives in a closure, so it cannot be
 *     reached by property access, symbol access, descriptor inspection,
 *     prototype walking or enumeration. `aggregate` (which can carry
 *     write-capable `$out` / `$merge` stages) and every write method are simply
 *     absent — there is no Proxy wrapping the driver object to reflect into
 *     (D3-R11, hardened by D3-R12);
 *   - the cursor the facade returns is likewise a frozen facade exposing only
 *     `toArray()`, so no driver cursor/collection/client handle is reachable;
 *   - the projection deliberately excludes name, email and userId.
 *
 * The facade is an application-level safeguard ONLY. Any future authorised
 * real-data audit must additionally connect with a database account that has
 * read-only privileges; JavaScript guards are not a substitute for that.
 *
 * Output separates:
 *   - `confirmedIntegrityErrors` — structurally impossible states (missing or
 *     invalid counters, duplicate slot identifiers, unlinkable Test Center
 *     bookings, availability above configured capacity, more active bookings
 *     than the slot can hold). These are data faults, not style differences.
 *   - `uncertainDiscrepancies` — availability that is arithmetically unexpected
 *     but still within capacity. These can be caused by legitimately edited
 *     counters, legacy records or the historical R07 drift, so they are flagged
 *     for human investigation rather than declared corruption.
 *
 * Running it (never against production without separate written authorisation):
 *
 *   AUDIT_MONGODB_URI="mongodb://127.0.0.1:27019" \
 *   AUDIT_MONGODB_DB_NAME="lumi_hotfix_audit_sample" \
 *   node scripts/audit-seat-consistency.js
 *
 * A non-loopback URI (staging, production, Atlas) is refused unless BOTH
 * `AUDIT_ALLOW_REMOTE=1` and `AUDIT_AUTHORIZED_READ_ONLY=1` are set, so the
 * script cannot be pointed at real student data by accident. The `.env` file is
 * deliberately NOT loaded: this audit only ever uses `AUDIT_MONGODB_URI`.
 */

const { MongoClient } = require("mongodb");

const CANCELLED_STATUS = "cancelled";
const HOME_LOCATION = "home";
const TEST_CENTER_LOCATION = "test center";

/**
 * D3-R12 — the ONLY collection shape the audit ever touches. A frozen,
 * null-prototype facade holding a single `find` function; the real collection is
 * captured in a closure and is therefore unreachable by property access, symbol
 * access, descriptor inspection, prototype walking or enumeration.
 *
 * This replaces the earlier allow-listing Proxy (D3-R11). A Proxy still wraps the
 * real collection, so `Reflect.ownKeys`, `Object.getOwnPropertyDescriptors`,
 * private symbols and prototype access could reflect into driver internals. An
 * empty-prototype frozen facade removes that surface entirely — a method that is
 * not exposed is simply absent.
 *
 * Code-level safeguard only: a real-data audit must still authenticate with a
 * read-only database account.
 */
function asReadOnlyCollection(collection, label = "collection") {
  if (!collection || typeof collection.find !== "function") {
    throw new Error(`${label} is not a readable collection: find() is unavailable.`);
  }

  const facade = Object.create(null);
  Object.defineProperty(facade, "find", {
    // The raw collection is captured in this closure and nowhere else.
    value: function find(filter, options) {
      return asReadOnlyCursor(collection.find(filter, options), label);
    },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(facade);
}

/**
 * D3-R12 — expose only `toArray()` from a cursor, so neither the driver cursor
 * nor the client/database handle behind it can be reached through the object the
 * audit receives. A cursor without `toArray` is rejected rather than passed on.
 */
function asReadOnlyCursor(cursor, label = "collection") {
  if (!cursor || typeof cursor.toArray !== "function") {
    throw new Error(`${label}.find() did not return a readable cursor.`);
  }

  const facade = Object.create(null);
  Object.defineProperty(facade, "toArray", {
    value: function toArray() {
      return cursor.toArray();
    },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(facade);
}

/**
 * A stored seat counter is trustworthy only when it is a real, non-negative
 * integer. Strings, decimals, negatives, null and undefined are reported as
 * invalid so that they are never interpreted as a capacity.
 */
function asStoredSeatCount(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

const normalizeLocation = (value) => String(value ?? "").trim().toLowerCase();
const normalizeId = (value) => (value === undefined || value === null ? "" : String(value).trim());
const isCancelledBooking = (booking) =>
  String(booking?.status ?? "").trim().toLowerCase() === CANCELLED_STATUS;

const bookingRef = (booking) => (booking && booking._id ? String(booking._id) : "(no id)");
const scheduleRef = (schedule) => (schedule && schedule._id ? String(schedule._id) : "(no id)");

/**
 * Core audit. Pure read: takes live collections, returns a plain report object.
 *
 * @param {object}   options
 * @param {object}   options.bookingMockCollection  `bookingMock` collection (or a compatible stub)
 * @param {object}   options.schedulesCollection    `schedules` collection (or a compatible stub)
 * @param {number}   [options.sampleLimit]          max items listed per issue bucket (counts are always full)
 * @returns {Promise<object>} report
 */
async function runSeatConsistencyAudit({ bookingMockCollection, schedulesCollection, sampleLimit = 10 }) {
  if (!bookingMockCollection || !schedulesCollection) {
    throw new Error("runSeatConsistencyAudit requires bookingMockCollection and schedulesCollection.");
  }

  const schedules = asReadOnlyCollection(schedulesCollection, "schedules").find({}).toArray();
  const bookings = asReadOnlyCollection(bookingMockCollection, "bookingMock")
    .find(
      {},
      {
        // No name, no email, no userId: the report must not carry student identity.
        projection: { location: 1, status: 1, scheduleId: 1, slotId: 1 },
      }
    )
    .toArray();

  const [scheduleDocs, bookingDocs] = await Promise.all([schedules, bookings]);

  const issues = {
    invalidScheduleRecords: [],
    duplicateScheduleIds: [],
    invalidSlotRecords: [],
    duplicateSlotIds: [],
    unlinkableCenterBookings: [],
    ambiguousCenterBookings: [],
    unrecognisedLocationBookings: [],
    capacityMismatches: [],
  };

  // `issues.*` holds at most `sampleLimit` entries so the report stays readable,
  // so the exact totals are counted separately and reported as `issueCounts`.
  const issueCounts = Object.fromEntries(Object.keys(issues).map((key) => [key, 0]));
  let capacityErrorCount = 0;
  let capacityWarningCount = 0;
  let cancellationBlockedSlots = 0;

  const pushSample = (name, entry) => {
    issueCounts[name] += 1;
    if (issues[name].length < sampleLimit) issues[name].push(entry);
  };

  // D3-R10: one authoritative capacity verdict per physical schedule slot. The
  // set makes a duplicate verdict impossible by construction (the historical
  // defect recorded the same over-capacity slot once during slot validation and
  // again during the booking comparison, inflating the totals). `blocksCancellation`
  // mirrors the real guard in DELETE /bookings/:id, which refuses when the stored
  // availability is at or above totalSlot.
  const capacityVerdictedSlots = new Set();
  const recordCapacityMismatch = (record, physical, fields) => {
    const identity = physical.verdictIdentity;
    if (capacityVerdictedSlots.has(identity)) return;
    capacityVerdictedSlots.add(identity);
    if (fields.severity === "error") capacityErrorCount += 1;
    else capacityWarningCount += 1;
    if (fields.blocksCancellation) cancellationBlockedSlots += 1;
    pushSample("capacityMismatches", {
      scheduleRef: record.ref,
      // The scan ordinal disambiguates two schedules that share a missing or
      // duplicated _id; the physical index is the only unambiguous slot identity
      // when slotIds are missing or duplicated.
      scheduleOrdinal: record.ordinal,
      slotIndex: physical.index,
      slotId: physical.slotKey || null,
      ...fields,
    });
  };

  // ---- index schedules and their slots -------------------------------------
  // STRUCTURAL validation only (missing/duplicate identifiers, unusable
  // counters). Capacity verdicts are taken exactly once per physical slot in the
  // dedicated pass below, so a single over-capacity slot can never be counted
  // twice (D3-R10).
  //
  // D3-R13: two SEPARATE structures replace the single Map that a missing or
  // duplicated `_id` could overwrite:
  //   - `physicalSchedules` holds EVERY schedule returned by the query, in scan
  //     order, and alone drives structural + capacity analysis. A schedule whose
  //     id repeats or is absent still occupies its own ordinal, so its slots can
  //     never be dropped by a later schedule sharing its key;
  //   - `schedulesById` is a LOGICAL index used only to resolve bookings. A key
  //     with more than one candidate is ambiguous and is never resolved to an
  //     arbitrary record.
  const physicalSchedules = [];
  const schedulesById = new Map();
  let slotsScanned = 0;
  let scheduleOrdinal = 0;

  for (const schedule of scheduleDocs) {
    const ordinal = scheduleOrdinal++;
    const ref = scheduleRef(schedule);
    const logicalId = normalizeId(schedule && schedule._id);
    const slotsById = new Map();
    const physicalSlots = [];
    const timeSlots = Array.isArray(schedule.timeSlots) ? schedule.timeSlots : [];

    timeSlots.forEach((slot, index) => {
      slotsScanned += 1;
      const slotKey = normalizeId(slot && slot.slotId);
      if (!slotsById.has(slotKey)) slotsById.set(slotKey, []);
      slotsById.get(slotKey).push({ index, slot: slot || {} });
      // Globally unique identity: a schedule ordinal plus the physical index, so
      // two schedules (or two slots) that share a missing/duplicate slotId can
      // never collide and be deduplicated into one verdict.
      physicalSlots.push({ index, slotKey, slot: slot || {}, verdictIdentity: `${ordinal}\u0000${index}` });
    });

    const record = { ordinal, ref, logicalId, schedule, slotsById, physicalSlots };
    physicalSchedules.push(record);

    for (const [slotKey, entries] of slotsById.entries()) {
      if (slotKey === "") {
        pushSample("invalidSlotRecords", {
          scheduleRef: ref,
          scheduleOrdinal: ordinal,
          slotId: null,
          slotIndex: entries[0].index,
          reason: "missing-slotId",
          slot: entries[0].slot.slot === undefined ? "missing" : entries[0].slot.slot,
          totalSlot:
            entries[0].slot.totalSlot === undefined ? "missing" : entries[0].slot.totalSlot,
        });
      }
      if (entries.length > 1) {
        pushSample("duplicateSlotIds", {
          scheduleRef: ref,
          scheduleOrdinal: ordinal,
          slotId: slotKey,
          duplicates: entries.length,
          slotIndexes: entries.map((entry) => entry.index),
        });
      }

      for (const { index, slot } of entries) {
        const available = asStoredSeatCount(slot.slot);
        const capacity = asStoredSeatCount(slot.totalSlot);
        if (available === null || capacity === null) {
          pushSample("invalidSlotRecords", {
            scheduleRef: ref,
            scheduleOrdinal: ordinal,
            slotId: slotKey || null,
            slotIndex: index,
            reason:
              capacity === null && available === null
                ? "invalid-slot-and-totalSlot"
                : capacity === null
                  ? "invalid-or-missing-totalSlot"
                  : "invalid-slot",
            slot: slot.slot === undefined ? "missing" : slot.slot,
            totalSlot: slot.totalSlot === undefined ? "missing" : slot.totalSlot,
          });
        }
      }
    }

    if (logicalId) {
      if (!schedulesById.has(logicalId)) schedulesById.set(logicalId, []);
      schedulesById.get(logicalId).push(record);
    } else {
      // Defensive completeness finding: MongoDB assigns `_id` to persisted rows,
      // so an absent id means the row cannot be linked at all. It is reported,
      // but its slots are still capacity-checked below.
      pushSample("invalidScheduleRecords", {
        scheduleRef: ref,
        scheduleOrdinal: ordinal,
        reason: "missing-or-unusable-schedule-id",
        note: "MongoDB normally assigns _id; this is a defensive completeness finding.",
      });
    }
  }

  // Duplicate logical ids are reported once per id (mirroring duplicateSlotIds):
  // both physical schedules stay in `physicalSchedules`, but a booking naming the
  // id can no longer be attributed to either one.
  for (const [scheduleId, candidates] of schedulesById.entries()) {
    if (candidates.length > 1) {
      pushSample("duplicateScheduleIds", {
        scheduleId,
        duplicates: candidates.length,
        scheduleOrdinals: candidates.map((candidate) => candidate.ordinal),
        note: "Bookings naming this id are ambiguous and are never attributed to one schedule.",
      });
    }
  }

  // ---- count active bookings per (schedule, slot) --------------------------
  const activeBySlot = new Map();
  let activeBookings = 0;
  let cancelledBookings = 0;

  for (const booking of bookingDocs) {
    if (isCancelledBooking(booking)) {
      cancelledBookings += 1;
      continue;
    }
    activeBookings += 1;

    const location = normalizeLocation(booking.location);
    if (location !== HOME_LOCATION && location !== TEST_CENTER_LOCATION) {
      pushSample("unrecognisedLocationBookings", {
        bookingRef: bookingRef(booking),
        location: booking.location === undefined ? null : booking.location,
        status: booking.status === undefined ? null : booking.status,
        note: "Cancellation now refuses an unrecognised location instead of assuming Home.",
      });
    }

    const scheduleKey = normalizeId(booking.scheduleId);
    const slotKey = normalizeId(booking.slotId);
    if (!scheduleKey || !slotKey) continue;

    const compositeKey = `${scheduleKey}\u0000${slotKey}`;
    activeBySlot.set(compositeKey, (activeBySlot.get(compositeKey) || 0) + 1);
  }

  // ---- Test Center bookings that cannot be linked to a slot ----------------
  for (const booking of bookingDocs) {
    if (normalizeLocation(booking.location) !== TEST_CENTER_LOCATION) continue;

    const scheduleKey = normalizeId(booking.scheduleId);
    const slotKey = normalizeId(booking.slotId);

    if (!scheduleKey || !slotKey) {
      pushSample("unlinkableCenterBookings", {
        bookingRef: bookingRef(booking),
        scheduleId: scheduleKey || null,
        slotId: slotKey || null,
        cancelled: isCancelledBooking(booking),
        reason: "missing-schedule-or-slot-reference",
      });
      continue;
    }

    const candidates = schedulesById.get(scheduleKey) || [];
    if (candidates.length === 0) {
      pushSample("unlinkableCenterBookings", {
        bookingRef: bookingRef(booking),
        scheduleId: scheduleKey,
        slotId: slotKey,
        cancelled: isCancelledBooking(booking),
        reason: "schedule-not-found",
      });
      continue;
    }

    // D3-R13: a duplicated schedule id is ambiguous. The booking is reported and
    // is NEVER attributed to an arbitrary one of the candidate schedules.
    if (candidates.length > 1) {
      pushSample("ambiguousCenterBookings", {
        bookingRef: bookingRef(booking),
        scheduleId: scheduleKey,
        slotId: slotKey,
        matches: candidates.length,
        reason: "ambiguous-schedule",
        cancelled: isCancelledBooking(booking),
      });
      continue;
    }

    const matches = candidates[0].slotsById.get(slotKey) || [];
    if (matches.length === 0) {
      pushSample("unlinkableCenterBookings", {
        bookingRef: bookingRef(booking),
        scheduleId: scheduleKey,
        slotId: slotKey,
        cancelled: isCancelledBooking(booking),
        reason: "slot-not-found",
      });
    } else if (matches.length > 1) {
      pushSample("ambiguousCenterBookings", {
        bookingRef: bookingRef(booking),
        scheduleId: scheduleKey,
        slotId: slotKey,
        matches: matches.length,
        reason: "ambiguous-slot",
        cancelled: isCancelledBooking(booking),
      });
    }
  }

  // ---- capacity vs active bookings ----------------------------------------
  // ONE authoritative verdict per physical slot (D3-R10). A duplicate verdict
  // is impossible: `recordCapacityMismatch` keys on (scan ordinal, physical
  // index), so the same slot can never be counted twice even across passes.
  // D3-R13: this pass iterates EVERY physical schedule, never the logical index,
  // so a missing or duplicated `_id` cannot remove a schedule from the analysis.
  for (const record of physicalSchedules) {
    // Bookings are attributable only when the schedule's id resolves to EXACTLY
    // one physical schedule; missing and duplicated ids are reported above and
    // are never resolved arbitrarily.
    const candidates = record.logicalId ? schedulesById.get(record.logicalId) || [] : [];
    const scheduleLinkable = candidates.length === 1;

    for (const physical of record.physicalSlots) {
      const { slotKey, slot } = physical;
      const available = asStoredSeatCount(slot.slot);
      const capacity = asStoredSeatCount(slot.totalSlot);

      // Unusable counters are reported structurally above and get no capacity verdict.
      if (available === null || capacity === null) continue;

      // Availability above configured capacity is a structural fault and is
      // verdictable whether or not the slot's bookings can be attributed to it.
      if (available > capacity) {
        recordCapacityMismatch(record, physical, {
          kind: "availability-above-capacity",
          severity: "error",
          totalSlot: capacity,
          availableSeats: available,
          activeBookings: null,
          expectedAvailable: null,
          delta: available - capacity,
          possibleR07Drift: false,
          blocksCancellation: true,
        });
        continue;
      }

      // An unlinkable schedule (missing/duplicated id) or a missing/duplicated
      // slotId makes "availability vs its bookings" unattributable (already
      // reported structurally), so no comparison is made.
      if (!scheduleLinkable) continue;
      const linkableSlot = slotKey !== "" && (record.slotsById.get(slotKey) || []).length === 1;
      if (!linkableSlot) continue;

      const counted = activeBySlot.get(`${record.logicalId}\u0000${slotKey}`) || 0;
      const expected = capacity - counted;
      if (available === expected) continue;

      const overcommitted = counted > capacity;
      recordCapacityMismatch(record, physical, {
        kind: overcommitted
          ? "more-active-bookings-than-capacity"
          : "availability-does-not-match-capacity-minus-active-bookings",
        severity: overcommitted ? "error" : "warning",
        totalSlot: capacity,
        availableSeats: available,
        activeBookings: counted,
        expectedAvailable: expected,
        delta: available - expected,
        // Positive delta (too many seats free) is the direction the historical
        // R07 defect pushed counters, and is the one that can oversell.
        possibleR07Drift: available > expected,
        blocksCancellation: available >= capacity,
      });
    }
  }

  const confirmedIntegrityErrors =
    issueCounts.invalidScheduleRecords +
    issueCounts.duplicateScheduleIds +
    issueCounts.invalidSlotRecords +
    issueCounts.duplicateSlotIds +
    issueCounts.unlinkableCenterBookings +
    issueCounts.ambiguousCenterBookings +
    issueCounts.unrecognisedLocationBookings +
    capacityErrorCount;

  return {
    audit: "seat-consistency",
    readOnly: true,
    generatedAt: new Date().toISOString(),
    totals: {
      // D3-R13: every physical schedule returned by the query is scanned, even
      // when ids are missing or duplicated.
      schedulesScanned: physicalSchedules.length,
      slotsScanned,
      bookingsScanned: bookingDocs.length,
      activeBookings,
      cancelledBookings,
    },
    // Exact totals for every bucket (never understated by sampling).
    issueCounts,
    // At most `sampleLimit` representative entries per bucket.
    issues,
    summary: {
      // See `metricSemantics` below. All of these are OCCURRENCE counts except
      // `cancellationBlockedSlots`, which counts unique physical slots.
      confirmedIntegrityErrors,
      uncertainDiscrepancies: capacityWarningCount,
      cancellationBlockedSlots,
      capacityErrors: capacityErrorCount,
      capacityWarnings: capacityWarningCount,
      sampledAt: sampleLimit,
    },
    // Names the semantics explicitly so the two families of metric are never
    // presented interchangeably: a single record may raise several occurrences,
    // and an occurrence count is not a unique-record count.
    metricSemantics: {
      bucketCounts:
        "issueCounts.<bucket> holds occurrence counts, and is never reduced by sampleLimit. Each capacityMismatches occurrence is one physical schedule slot (scan ordinal + slotIndex), so issueCounts.capacityMismatches is also the number of distinct affected slots (D3-R10). invalidScheduleRecords is one occurrence per physical schedule with a missing/unusable _id; duplicateScheduleIds is one occurrence per logical _id shared by more than one physical schedule (D3-R13).",
      confirmedIntegrityErrors:
        "Occurrence count, NOT a count of unique documents or students: invalid/unidentified schedule records + duplicated schedule ids + invalid slot counters + duplicate slotIds + unlinkable Test Center bookings + ambiguous Test Center bookings + unrecognised locations + capacity mismatches of error severity. One booking contributes at most one occurrence; one schedule may contribute several.",
      uncertainDiscrepancies:
        "Occurrence count of in-capacity arithmetic drift (capacity mismatches of warning severity). Drift is a prompt to investigate, not proof of corruption.",
      cancellationBlockedSlots:
        "Unique physical schedule slots whose stored availability is at or above totalSlot, so a seat cannot be returned without overselling and DELETE /bookings/:id refuses the cancellation (409). Scope: the capacity rule only — slots whose counters are invalid or duplicated are also uncancellable but are counted in the structural buckets above.",
    },
    notes: [
      "Read-only: no document, index or counter was modified.",
      "The read-only facade exposes only find(), and its cursor only toArray(); aggregate() (and therefore $out/$merge), findOne and every write method are absent, so no route to the driver exists through the objects the audit receives (D3-R11, hardened by D3-R12: no Proxy over the collection to reflect into). This is a code-level safeguard only — a real-data audit must also use a read-only database account.",
      "Each physical schedule slot receives at most one capacity verdict (D3-R10), so an over-capacity slot cannot inflate confirmedIntegrityErrors or cancellationBlockedSlots.",
      "Every physical schedule is scanned, including ones with a missing or duplicated _id; such schedules are reported and their slots are still capacity-checked, but no booking is attributed to an ambiguous id (D3-R13).",
      "An availability that differs from totalSlot - activeBookings is not proof of corruption: manual capacity edits, legacy rows and missing booking links can all explain it.",
      "Historical reconciliation of seat counters requires separate written authorisation and is NOT performed here.",
      "Availability at or above totalSlot now causes DELETE /bookings/:id to refuse the cancellation (409) rather than oversell the slot.",
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackUri(uri) {
  try {
    return LOOPBACK_HOSTS.has(new URL(uri).hostname);
  } catch {
    return false;
  }
}

function printReport(report) {
  const { totals, issues, issueCounts, summary } = report;
  console.log("=== Luminedge seat-consistency audit (READ-ONLY) ===");
  console.log(`generated: ${report.generatedAt}`);
  console.log(
    `scanned: ${totals.schedulesScanned} schedules, ${totals.slotsScanned} slots, ` +
      `${totals.bookingsScanned} bookings (${totals.activeBookings} active, ${totals.cancelledBookings} cancelled)`
  );
  console.log("");
  for (const [name, entries] of Object.entries(issueCounts)) {
    const shown = issues[name].length;
    const suffix = shown < entries ? ` (showing first ${shown})` : "";
    console.log(`${name}: ${entries}${entries === 0 ? " (none)" : suffix}`);
    for (const entry of issues[name]) console.log(`  - ${JSON.stringify(entry)}`);
  }
  console.log("");
  console.log(`confirmed integrity errors : ${summary.confirmedIntegrityErrors}`);
  console.log(`uncertain discrepancies    : ${summary.uncertainDiscrepancies}`);
  console.log(`slots blocking cancellation: ${summary.cancellationBlockedSlots}`);
  console.log("");
  for (const note of report.notes) console.log(`note: ${note}`);
}

async function main() {
  const uri = process.env.AUDIT_MONGODB_URI;
  if (!uri) {
    console.error(
      "AUDIT_MONGODB_URI is not set. This audit never uses MONGODB_URI/.env so it cannot be pointed at production by accident."
    );
    process.exit(1);
  }

  if (
    !isLoopbackUri(uri) &&
    !(process.env.AUDIT_ALLOW_REMOTE === "1" && process.env.AUDIT_AUTHORIZED_READ_ONLY === "1")
  ) {
    console.error(
      "Refusing a non-loopback target. Set AUDIT_ALLOW_REMOTE=1 and AUDIT_AUTHORIZED_READ_ONLY=1 only with written authorisation for a read-only audit."
    );
    process.exit(2);
  }

  const dbName =
    (process.env.AUDIT_MONGODB_DB_NAME || "").trim() ||
    require("../config/databaseName").databaseName();

  const client = new MongoClient(uri, { appName: "seat-consistency-audit" });
  try {
    await client.connect();
    const db = client.db(dbName);
    console.log(`audit target: ${dbName} (read-only)`);
    const report = await runSeatConsistencyAudit({
      bookingMockCollection: db.collection("bookingMock"),
      schedulesCollection: db.collection("schedules"),
    });
    printReport(report);
  } finally {
    await client.close();
  }
}

module.exports = { runSeatConsistencyAudit, asReadOnlyCollection, asReadOnlyCursor };

if (require.main === module) {
  main().catch((error) => {
    console.error("Seat-consistency audit failed:", error);
    process.exit(1);
  });
}
