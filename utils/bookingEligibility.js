"use strict";

/**
 * FIX-04 — pure booking-eligibility primitives (no I/O, no MongoDB, no Express).
 *
 * Everything the booking gate needs to decide *whether* a request is allowed
 * lives here so it can be unit-tested at exact boundaries without a database,
 * a replica set or an injected clock:
 *
 *   - strict Dhaka (UTC+06:00, no DST) date/time parsing;
 *   - the 24-hour lead-time rule and the past-test prohibition;
 *   - course/mode normalisation (PTE === Pearson PTE);
 *   - MR expiry parsing (ISO instants and legacy date-only values);
 *   - renewal-aware entitlement allocation (earliest-expiry-first).
 *
 * POLICY DECISIONS RECORDED HERE (approved on Day 4; see the handoff):
 *
 *  1. FAIL CLOSED. Eligibility requires a *verifiable* MR row for the requested
 *     course and mode. There is no synthetic "lifetime MR" built from
 *     `users.mock`, no missing-expiry-means-valid rule and no malformed-value
 *     leniency. `users.mock` stays an independent counter and is never treated
 *     as evidence of course-specific entitlement.
 *  2. History is never silently discarded. A historical booking that matches
 *     the course and mode but cannot be attributed to a provably-eligible MR row
 *     (unparseable test date, no row that could have covered it) is charged
 *     against the *live* pool instead of being ignored, so unattributable
 *     history can never inflate the remaining capacity.
 *  3. Bookings are attributed earliest-expiry-first, and — when the MR row
 *     carries a usable purchase timestamp — never to an MR purchased *after*
 *     the historical test. An unknown purchase timestamp is a documented
 *     leniency (`uncertainty.unknownPurchaseDates`), never an over-allocation.
 *  4. There is no booking -> MR foreign key in this data model. The
 *     reconstruction below is the documented best-effort policy required by the
 *     audit; it is *not* claimed to be an exact historical linkage.
 *  5. D4-R01: expiry and purchase timestamps are validated component by
 *     component — calendar (month length and leap years), clock and UTC offset —
 *     and the instant is then computed from those validated components.
 *     `Date.parse` is deliberately not trusted: it accepts impossible calendar
 *     dates by rolling them over (2027-02-30 becomes 2027-03-02) and accepts
 *     24:00:00, so a malformed expiry could otherwise read as a different date.
 *  6. D4-R02: a quantity must be a non-negative safe integer (or a digit-only
 *     string written by an older admin tool). Fractions, negatives, booleans and
 *     malformed values are never rounded or truncated into usable entitlement; a
 *     malformed row contributes no capacity and is reported separately from a
 *     genuinely exhausted one.
 *  7. D4-R03: an empty mode is never evidence of eligibility. A request without a
 *     usable mode is refused, and an MR row without a test type can never match
 *     anything — two empty strings are not a verified course-and-mode match.
 *  8. D4-R04: a credit can only be spent on a test that happened *after* it was
 *     bought — `purchase <= testStart <= expiry`, both boundaries inclusive. An
 *     MR purchased after the requested test did not exist yet and contributes no
 *     capacity, however valid its expiry is. This rule is applied by one
 *     predicate (`isUsableAtTestStart`) everywhere requested-test capacity is
 *     calculated. Historical attribution is deliberately *not* filtered by it:
 *     each historical booking is attributed against its own test instant, so an
 *     MR purchased after the requested test may still cover a later booking.
 */

const DHAKA_OFFSET_MINUTES = 360; // Asia/Dhaka is UTC+06:00, fixed (no DST since 2009)
const DHAKA_OFFSET_MS = DHAKA_OFFSET_MINUTES * 60 * 1000;
const MIN_BOOKING_LEAD_MS = 24 * 60 * 60 * 1000;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// "HH", "HH:mm", "HH:mm:ss" and "HH:mm:ss.sss" are all accepted, because legacy
// schedule rows were written by more than one client. A bare "HH" is an exact
// instant, not an ambiguity, so accepting it removes a lockout without weakening
// the gate.
const TIME_PATTERN = /^(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
// Explicit UTC instant only (a trailing Z or a numeric offset). A bare
// "2026-04-01T10:00:00" is deliberately NOT accepted: Date.parse would read it
// in the *server's* local zone, which is exactly the ambiguity this module exists
// to remove.
//
// D4-R01: the matched groups are validated individually below and the instant is
// computed arithmetically from them. `Date.parse` was previously trusted with the
// matched string, but it accepts impossible calendar dates by rolling them over
// ("2027-02-30T00:00:00Z" parses as 2027-03-02) and accepts a 24:00:00 clock, so
// a malformed expiry could read as a different — possibly still valid — date.
const EXPLICIT_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):?(\d{2}))$/;

const MINUTE_MS = 60 * 1000;
// ECMAScript date range is +-8.64e15 ms; anything outside it is not an instant.
const MAX_INSTANT_MS = 8.64e15;
const INTEGER_QUANTITY_PATTERN = /^\d+$/;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (year, month) => (month === 2 ? (isLeapYear(year) ? 29 : 28) : MONTH_LENGTHS[month - 1]);

/** True only for a real calendar date (rejects 2027-02-29, 2027-04-31, month 13). */
function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

/**
 * Parse "YYYY-MM-DD" as a real calendar date.
 * Rejects well-shaped but impossible dates (2026-13-40, 2026-02-30, 2026-00-10).
 */
function parseDhakaDate(value) {
  const match = DATE_PATTERN.exec(String(value ?? "").trim());
  if (!match) return { ok: false, reason: "invalid-date" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "invalid-date" };
  const utc = Date.UTC(year, month - 1, day);
  const round = new Date(utc);
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day
  ) {
    return { ok: false, reason: "invalid-date" };
  }
  return { ok: true, year, month, day };
}

/**
 * Parse "HH", "HH:mm" or "HH:mm:ss[.sss]" as a wall-clock time.
 * Rejects 24:00, 12:60, 12:00:60 and anything non-numeric.
 */
function parseClockTime(value) {
  const match = TIME_PATTERN.exec(String(value ?? "").trim());
  if (!match) return { ok: false, reason: "invalid-time" };
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  const millis = match[4] === undefined ? 0 : Number(String(match[4]).padEnd(3, "0"));
  if (hours > 23 || minutes > 59 || seconds > 59) return { ok: false, reason: "invalid-time" };
  return { ok: true, hours, minutes, seconds, millis };
}

/**
 * Combine a stored Dhaka date string and wall-clock time string into an exact
 * UTC instant. Independent of the process timezone: the arithmetic is done on
 * Date.UTC and the +06:00 offset is applied explicitly.
 */
function parseDhakaDateTime(dateValue, timeValue) {
  const date = parseDhakaDate(dateValue);
  if (!date.ok) return { ok: false, reason: date.reason };
  const time = parseClockTime(timeValue);
  if (!time.ok) return { ok: false, reason: time.reason };
  const ms =
    Date.UTC(date.year, date.month - 1, date.day, time.hours, time.minutes, time.seconds, time.millis) -
    DHAKA_OFFSET_MS;
  return { ok: true, ms };
}

/** Inverse of parseDhakaDateTime — used by tests and diagnostics only. */
function dhakaPartsFromMs(ms) {
  const shifted = new Date(Number(ms) + DHAKA_OFFSET_MS);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * The 24-hour student lead time plus the universal past-test prohibition.
 * `isVerifiedAdmin` may only relax the lead time — never the past-test rule.
 */
function evaluateLeadTime({ testStartMs, nowMs, isVerifiedAdmin = false }) {
  if (!isFiniteNumber(testStartMs)) return { ok: false, reason: "invalid-test-time" };
  if (!isFiniteNumber(nowMs)) return { ok: false, reason: "invalid-now" };
  if (testStartMs <= nowMs) return { ok: false, reason: "past" };
  if (testStartMs - nowMs < MIN_BOOKING_LEAD_MS && !isVerifiedAdmin) {
    return { ok: false, reason: "lead-time" };
  }
  return { ok: true, leadMs: testStartMs - nowMs };
}

/**
 * Course identity normalisation. The only alias is the register-documented
 * PTE === "Pearson PTE" equivalence; every other spelling is compared as-is
 * (trimmed, whitespace-collapsed, lower-cased), which is what removes the
 * case-sensitivity bypass that existed on the old per-course cap.
 */
function normalizeCourseName(value) {
  let v = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (v === "pte") v = "pearson pte";
  return v;
}

/** Mode ("Computer-Based" / "Paper-Based" / whatever the data holds) normalisation. */
function normalizeMode(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const normalize = (value) => String(value ?? "").trim().toLowerCase();

/**
 * D4-R01 — parse an explicit ISO-8601 instant ("2030-01-01T00:00:00Z",
 * "2030-01-01T00:00:00+06:00", "2030-01-01T00:00:00.999-05:30").
 *
 * Every component is validated independently — calendar (month length and leap
 * years), clock (00-23 / 00-59 / 00-59) and the UTC offset (00-23 / 00-59, or
 * `Z`) — and the result is computed from those validated components with
 * `setUTCFullYear`/`setUTCHours`, so the returned instant always corresponds
 * exactly to the validated wall clock plus offset. Nothing is interpreted in the
 * process timezone, and `Date.parse` is never used to derive the value.
 */
function parseExplicitInstant(value) {
  const match = EXPLICIT_INSTANT_PATTERN.exec(String(value ?? "").trim());
  if (!match) return { ok: false, reason: "invalid" };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(String(match[7]).padEnd(3, "0"));

  if (!isValidCalendarDate(year, month, day)) return { ok: false, reason: "invalid" };
  if (hours > 23 || minutes > 59 || seconds > 59) return { ok: false, reason: "invalid" };

  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    const offsetHours = Number(match[9]);
    const offsetMinutesPart = Number(match[10]);
    // A real UTC offset never reaches 24 hours or 60 minutes; "+24:00" is not a
    // timezone, it is a malformed value, and must not be normalised into one.
    if (offsetHours > 23 || offsetMinutesPart > 59) return { ok: false, reason: "invalid" };
    const magnitude = offsetHours * 60 + offsetMinutesPart;
    offsetMinutes = match[8] === "-" ? -magnitude : magnitude;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, millis);
  const ms = date.getTime() - offsetMinutes * MINUTE_MS;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_INSTANT_MS) return { ok: false, reason: "invalid" };
  return { ok: true, ms };
}

/**
 * A numeric epoch is unambiguous, but only if it is a real, safe millisecond
 * value. Fractions and out-of-range magnitudes are refused rather than rounded.
 */
function parseEpochNumber(value) {
  if (!isFiniteNumber(value)) return { ok: false, reason: "invalid" };
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_INSTANT_MS) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, ms: value };
}

/**
 * D4-R02 — parse an MR row's purchased quantity.
 *
 * Accepted: a non-negative safe integer (`2`, and BSON doubles that hold whole
 * values such as `2.0`), or a digit-only string written by an older admin tool
 * (`"2"`). Rejected: fractions (`0.5`, `1.5`, `"1.5"`), negatives, booleans,
 * null/undefined, empty or malformed strings, NaN, Infinity and integers outside
 * the safe range. Nothing is rounded or truncated: a fractional row can never
 * become one usable credit.
 *
 * Zero is *valid but empty* — a fully consumed or never-activated row — so
 * "exhausted" stays distinguishable from "malformed" in the diagnostics.
 */
function parseMockQuantity(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false };
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!INTEGER_QUANTITY_PATTERN.test(raw)) return { ok: false };
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  }
  return { ok: false };
}

/**
 * D4-R02 — is `users.mock` a balance this endpoint may spend?
 *
 * Requires at least one whole credit, as a real number: `$inc` cannot decrement a
 * string, so a balance that is not an integer must be refused rather than turned
 * into a fractional or negative post-booking balance.
 */
function isWholeCreditBalance(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Parse an MR expiry into an instant.
 *  - Date instance / safe integer epoch  -> that instant
 *  - "YYYY-MM-DD"                        -> END of that day, Dhaka time
 *    (legacy rows were sometimes written date-only; the MR is valid through it)
 *  - explicit ISO instant with Z or offset -> validated component by component
 *    (D4-R01), so an impossible calendar date, a 24:00 clock or an out-of-range
 *    offset is `invalid` instead of silently becoming a different date
 *  - anything else (including missing)   -> not usable
 */
function parseExpiryInstant(value) {
  if (value === null || value === undefined) return { ok: false, reason: "missing" };
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, reason: "invalid" };
  }
  if (typeof value === "number") return parseEpochNumber(value);
  const raw = String(value).trim();
  if (raw === "") return { ok: false, reason: "missing" };
  const dateOnly = parseDhakaDate(raw);
  if (dateOnly.ok) {
    return {
      ok: true,
      ms: Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day, 23, 59, 59, 999) - DHAKA_OFFSET_MS,
    };
  }
  return parseExplicitInstant(raw);
}

/**
 * Parse the MR purchase/issue instant when the row carries one.
 * `createdAt` is written by the admin mock-management routes; `issuedAt` is
 * accepted as an alternative spelling.
 *
 * Three outcomes matter to the caller:
 *  - `missing`  — no purchase timestamp at all: the documented legacy leniency
 *                 (the row may cover history, because that is what the old
 *                 workflow left us);
 *  - `invalid`  — a non-empty value that is not a real instant (impossible
 *                 calendar date, out-of-range offset, garbage). D4-R01 treats
 *                 this as **corrupt**, not as "unknown": the row may not be
 *                 relied on for historical attribution, because the date it
 *                 claims cannot be established;
 *  - `ok`       — a validated instant.
 */
function parsePurchaseInstant(rawRow) {
  if (!rawRow || typeof rawRow !== "object") return { ok: false, reason: "missing" };
  const candidate = rawRow.createdAt !== undefined ? rawRow.createdAt : rawRow.issuedAt;
  if (candidate === null || candidate === undefined || candidate === "") {
    return { ok: false, reason: "missing" };
  }
  if (candidate instanceof Date) {
    const ms = candidate.getTime();
    return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, reason: "invalid" };
  }
  if (typeof candidate === "number") return parseEpochNumber(candidate);
  const raw = String(candidate).trim();
  if (raw === "") return { ok: false, reason: "missing" };
  const instant = parseExplicitInstant(raw);
  if (instant.ok) return instant;
  const dateOnly = parseDhakaDate(raw);
  if (dateOnly.ok) {
    return { ok: true, ms: Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day) - DHAKA_OFFSET_MS };
  }
  return { ok: false, reason: "invalid" };
}

/** Best-effort test instant for a stored booking row (Home "testTime" / TC "startTime"). */
function bookingTestInstant(booking) {
  if (!booking || typeof booking !== "object") return { ok: false, reason: "invalid-booking" };
  const time = booking.testTime !== undefined && booking.testTime !== null && booking.testTime !== ""
    ? booking.testTime
    : booking.startTime;
  return parseDhakaDateTime(booking.bookingDate, time);
}

/** True when a stored booking counts toward entitlement usage. */
const isActiveBookingRow = (booking) =>
  !booking || typeof booking !== "object" ? false : normalize(booking.status) !== "cancelled";

const FAIL_REASONS = Object.freeze([
  "no-mr-rows",
  "no-matching-mr",
  "missing-mode",
  "missing-expiry",
  "invalid-expiry",
  "invalid-purchase",
  "invalid-quantity",
  "expired-before-test",
  "not-yet-purchased",
  "capacity-exhausted",
]);

function ineligible(reason, extra = {}) {
  return {
    eligible: false,
    reason,
    availableAtTest: 0,
    rowsMatched: 0,
    rowsLive: 0,
    historyConsidered: 0,
    historyAttributed: 0,
    historyUnattributed: 0,
    uncertainty: emptyUncertainty(),
    ...extra,
  };
}

const emptyUncertainty = () => ({
  missingExpiryRows: 0,
  invalidExpiryRows: 0,
  invalidPurchaseRows: 0,
  invalidQuantityRows: 0,
  unknownPurchaseDates: 0,
  notYetPurchasedRows: 0,
  unattributableHistory: 0,
  unresolvedCharges: 0,
});

/**
 * D4-R04 — the ONE requested-test eligibility predicate.
 *
 * A credit may be spent on a test only inside the row's own validity window:
 *
 *     purchase <= testStart <= expiry        (both boundaries inclusive)
 *
 * - A row whose purchase timestamp is a validated instant must not be spent
 *   before that instant: an MR bought after the test did not exist yet.
 * - A row with an ABSENT purchase timestamp keeps the documented legacy
 *   leniency (the old workflow did not always write one). Rows with a *corrupt*
 *   purchase timestamp were already excluded from `usable` by D4-R01, so
 *   `!purchase.ok` here can only mean "missing".
 *
 * Historical attribution must NOT use this predicate. Each historical booking is
 * attributed against its own test instant (see evaluateEntitlement), so an MR
 * purchased after the *requested* test can still legitimately cover a booking
 * that happened after that MR's purchase.
 */
function isUsableAtTestStart(row, testStartMs) {
  if (!row || !row.expiry || !row.expiry.ok) return false;
  if (!isFiniteNumber(testStartMs)) return false;
  if (row.expiry.ms < testStartMs) return false;
  if (row.purchase && row.purchase.ok && row.purchase.ms > testStartMs) return false;
  return true;
}

/**
 * Renewal-aware entitlement evaluation.
 *
 * @param {object}   input
 * @param {any}      input.mocks        raw `user.mocks` array
 * @param {string}   input.course       normalized requested course
 * @param {string}   input.mode         normalized requested mode
 * @param {number}   input.testStartMs  requested test instant (Dhaka-parsed)
 * @param {Array}    input.bookings     stored booking rows (any course; cancelled rows ignored)
 * @returns {object} decision + diagnostics (diagnostics are for server-side
 *                   logging/tests only and are never returned to the caller)
 */
function evaluateEntitlement({ mocks, course, mode, testStartMs, bookings } = {}) {
  const rows = Array.isArray(mocks) ? mocks : [];
  if (rows.length === 0) return ineligible("no-mr-rows");

  // D4-R03 — defensive, independent of the route: an empty mode is never proof
  // of a verified course-and-mode match. Without this, a request carrying no
  // testType matched an MR row carrying no testType, because both normalise to "".
  const requestedMode = normalizeMode(mode);
  if (requestedMode === "") return ineligible("missing-mode");
  const requestedCourse = normalizeCourseName(course);

  const candidates = rows
    .map((raw, index) => {
      const quantity = parseMockQuantity(raw && raw.mock);
      const rowCourse = normalizeCourseName(raw && raw.mockType);
      const rowMode = normalizeMode(raw && raw.testType);
      return {
        raw,
        index,
        quantity,
        capacity: quantity.ok ? quantity.value : 0,
        // D4-R02 — a malformed quantity is never rounded into usable entitlement.
        invalidQuantity: !quantity.ok,
        expiry: parseExpiryInstant(raw && raw.mrValidationExpiry),
        purchase: parsePurchaseInstant(raw),
        // Empty values never match: a row with no course or no test type is not
        // evidence of anything, and two empty strings are not a match.
        isCourse: rowCourse !== "" && rowCourse === requestedCourse,
        isMode: rowMode !== "" && rowMode === requestedMode,
      };
    })
    .filter((r) => r.isCourse && r.isMode);

  if (candidates.length === 0) return ineligible("no-matching-mr");

  const uncertainty = emptyUncertainty();
  uncertainty.missingExpiryRows = candidates.filter((r) => !r.expiry.ok && r.expiry.reason === "missing").length;
  uncertainty.invalidExpiryRows = candidates.filter((r) => !r.expiry.ok && r.expiry.reason === "invalid").length;
  uncertainty.invalidQuantityRows = candidates.filter((r) => r.invalidQuantity).length;
  // A corrupt purchase timestamp is NOT the same as an absent one: the date the
  // row claims cannot be established, so the row may not be relied upon.
  uncertainty.invalidPurchaseRows = candidates.filter(
    (r) => !r.purchase.ok && r.purchase.reason === "invalid"
  ).length;
  uncertainty.unknownPurchaseDates = candidates.filter(
    (r) => r.capacity > 0 && !r.purchase.ok && r.purchase.reason === "missing"
  ).length;

  const usable = candidates
    .filter((r) => !r.invalidQuantity && r.expiry.ok && r.purchase.reason !== "invalid")
    .sort(
      (a, b) =>
        a.expiry.ms - b.expiry.ms ||
        (a.purchase.ok ? a.purchase.ms : Infinity) - (b.purchase.ok ? b.purchase.ms : Infinity) ||
        a.index - b.index
    );

  // D4-R04 — rows that have not expired but were purchased *after* the requested
  // test did not exist at that instant. Counted for server-side diagnostics only;
  // they contribute no capacity anywhere below.
  uncertainty.notYetPurchasedRows = usable.filter(
    (r) => r.expiry.ms >= testStartMs && r.purchase.ok && r.purchase.ms > testStartMs
  ).length;

  // D4-R04 — requested-test capacity requires BOTH boundaries: already purchased
  // at the test AND not expired at the test. `notExpired` is kept only so a
  // future purchase is reported as `not-yet-purchased` rather than mislabelled
  // as an expired MR.
  const notExpired = usable.filter((r) => r.expiry.ms >= testStartMs);
  const live = notExpired.filter((r) => isUsableAtTestStart(r, testStartMs));
  if (live.length === 0) {
    if (usable.length === 0) {
      // Report the dominant data problem. These reasons are server-side only
      // (logged for diagnostics, asserted in tests) and never returned to the
      // caller, so this cannot be used as an entitlement oracle.
      if (uncertainty.invalidQuantityRows > 0) {
        return ineligible("invalid-quantity", { rowsMatched: candidates.length, uncertainty });
      }
      if (uncertainty.invalidPurchaseRows > 0) {
        return ineligible("invalid-purchase", { rowsMatched: candidates.length, uncertainty });
      }
      const reason = uncertainty.invalidExpiryRows > 0 ? "invalid-expiry" : "missing-expiry";
      return ineligible(reason, { rowsMatched: candidates.length, uncertainty });
    }
    if (notExpired.length > 0) {
      // Every otherwise-valid row that is still in date was bought after the
      // requested test, so the student held no entitlement at that moment.
      return ineligible("not-yet-purchased", { rowsMatched: candidates.length, uncertainty });
    }
    return ineligible("expired-before-test", { rowsMatched: candidates.length, uncertainty });
  }

  const pool = live.filter((r) => r.capacity > 0);
  if (pool.length === 0) {
    return ineligible("capacity-exhausted", { rowsMatched: candidates.length, rowsLive: live.length, uncertainty });
  }

  // Remaining capacity per usable row, in deterministic (earliest-expiry) order.
  // Quantities are validated safe integers, so this arithmetic cannot drift into
  // fractions.
  const remaining = usable.map((r) => Math.max(0, r.capacity));
  const indexOf = new Map(usable.map((r, i) => [r, i]));

  const history = (Array.isArray(bookings) ? bookings : [])
    .filter(isActiveBookingRow)
    .filter((b) => {
      const bookingCourse = normalizeCourseName(b && b.name);
      const bookingMode = normalizeMode(b && b.testType);
      return (
        bookingCourse !== "" &&
        bookingCourse === requestedCourse &&
        bookingMode !== "" &&
        bookingMode === requestedMode
      );
    })
    .map((b) => ({ booking: b, instant: bookingTestInstant(b) }));

  const dated = history.filter((h) => h.instant.ok).sort((a, b) => a.instant.ms - b.instant.ms);
  const undated = history.filter((h) => !h.instant.ok);

  let attributed = 0;
  const unattributable = [];

  for (const entry of dated) {
    const slot = usable.findIndex(
      (r, i) =>
        remaining[i] > 0 &&
        r.expiry.ms >= entry.instant.ms &&
        (!r.purchase.ok || r.purchase.ms <= entry.instant.ms)
    );
    if (slot === -1) {
      unattributable.push(entry.booking);
    } else {
      remaining[slot] -= 1;
      attributed += 1;
    }
  }
  // A booking with no parseable test date cannot be attributed at all.
  for (const entry of undated) unattributable.push(entry.booking);

  // Fail-safe: never let unattributable history inflate the remaining capacity.
  // Charge it against the live pool (earliest-expiry first). If the live pool is
  // already exhausted the request is refused anyway, so ignoring it could never
  // have granted anything.
  let unresolvedCharges = 0;
  for (let i = 0; i < unattributable.length; i += 1) {
    // D4-R04 — unattributable history may only be charged against rows that are
    // usable for the *requested* test (purchased by it and not expired at it).
    // Charging a future-purchased row here would invent capacity that does not
    // exist at the requested instant.
    const slot = usable.findIndex(
      (r, idx) => remaining[idx] > 0 && isUsableAtTestStart(r, testStartMs)
    );
    if (slot === -1) {
      unresolvedCharges += 1;
    } else {
      remaining[slot] -= 1;
    }
  }

  uncertainty.unattributableHistory = unattributable.length;
  uncertainty.unresolvedCharges = unresolvedCharges;

  const availableAtTest = usable.reduce(
    (sum, r, i) => (isUsableAtTestStart(r, testStartMs) ? sum + remaining[i] : sum),
    0
  );

  return {
    eligible: availableAtTest > 0,
    reason: availableAtTest > 0 ? "ok" : "capacity-exhausted",
    availableAtTest,
    rowsMatched: candidates.length,
    rowsLive: live.length,
    historyConsidered: history.length,
    historyAttributed: attributed,
    historyUnattributed: unattributable.length,
    uncertainty,
  };
}

module.exports = {
  DHAKA_OFFSET_MINUTES,
  DHAKA_OFFSET_MS,
  MIN_BOOKING_LEAD_MS,
  FAIL_REASONS,
  parseDhakaDate,
  parseClockTime,
  parseDhakaDateTime,
  dhakaPartsFromMs,
  evaluateLeadTime,
  normalizeCourseName,
  normalizeMode,
  parseExpiryInstant,
  parsePurchaseInstant,
  parseExplicitInstant,
  parseMockQuantity,
  isWholeCreditBalance,
  isUsableAtTestStart,
  bookingTestInstant,
  evaluateEntitlement,
};
