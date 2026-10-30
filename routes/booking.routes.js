const { Router } = require("express");
const { ObjectId } = require("mongodb");
const sanitizeHtml = require("sanitize-html");
const { waitUntil } = require("@vercel/functions");
const { emailSender, emailSenderBulk, logEmailOutcome } = require("../emailSender");
const { verifyToken, verifyAdmin, verifyStaff } = require("../middleware/auth");
const {
  parseDhakaDateTime,
  evaluateLeadTime,
  normalizeCourseName,
  normalizeMode,
  evaluateEntitlement,
  isWholeCreditBalance,
} = require("../utils/bookingEligibility");

const router = Router();

async function sendBookingConfirmationEmail(user, bookingRecord) {
  try {
    const bookingDateFormatted = new Date(bookingRecord.bookingDate).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    function convertTo12HourFormat(timeString) {
      if (!timeString) return "Not Available";
      const [hours, minutes] = timeString.split(":").map(Number);
      const ampm = hours >= 12 ? "PM" : "AM";
      const formattedHours = hours % 12 || 12;
      return `${formattedHours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
    }

    const testTimeRaw =
      bookingRecord.location === "Home" ? bookingRecord.testTime : bookingRecord.startTime;

    const testTime = convertTo12HourFormat(testTimeRaw);

    const safe = (v) => sanitizeHtml(String(v || ""), { allowedTags: [], allowedAttributes: {} });
    const subject = `Confirmation: Mock Test Booking for ${bookingDateFormatted}`;
    const messageContent = `
        <div>
          <p>Dear ${safe(user.name) || "Student"},</p>
          <p>This is a friendly reminder that your mock test is scheduled for <strong>${bookingDateFormatted}</strong>. Please find the details below:</p>
          <p><strong>Test Details:</strong></p>
          <ul>
            <li>Test Title: ${safe(bookingRecord.name)} ${safe(bookingRecord.testType)}</li>
            <li>Test Date: ${bookingDateFormatted}</li>
            <li>Test Time: ${testTime}</li>
            <li>Test Location: ${safe(bookingRecord.location)}</li>
            <li>Reporting Time: 30 minutes before Test Time</li>
            <li>Office Address: Level 12, Gawsia Twin Peak, 743 Satmasjid Road, Dhanmondi 9/A, Dhaka-1205, Bangladesh.</li>
          </ul>
          <p><strong>Important Instructions:</strong></p>
          <ul>
            <li>Arrive at least 30 minutes before the test time for check-in.</li>
            <li>Bring a valid photo ID (Passport/NID) that matches the ID information provided at the time of account creation.</li>
            <li>Bring your own stationery items (pens, pencils, erasers) as they will not be provided at the test venue.</li>
          </ul>
          <p><strong>Mock Test Terms & Conditions:</strong></p>
          <ul>
            <li>Purchased or course-provided mock test(s) must be used within 6 months of the MR date.</li>
            <li>Free mock test(s) must be taken within 10 days of the MR date.</li>
            <li>Mock test rescheduling requests must be made 24 hours prior to the booked test date.</li>
            <li>Any mismatch between the provided ID details and the ID shown on the test day may result in test cancellation, and no refunds will be issued in such cases.</li>
            <li>Late arrivals, no-shows, invalid photo IDs, or expired service validity may result in forfeiting the test, with no refund requests entertained.</li>
            <li>Students are required to maintain professional behavior with Luminedge employees at all times. Any instance of misbehavior may result in service cancellation, with no refund issued.</li>
          </ul>
          <p>To facilitate a smooth check-in process, kindly present your valid photo ID (Passport/NID) voucher to our office executive upon arrival. This step is crucial to confirm your eligibility for the mock test.</p>
          <p>We sincerely appreciate your cooperation in adhering to these guidelines. Your punctuality and preparedness will contribute to a successful and efficient mock test experience.</p>
          <p>Thank you for choosing Luminedge for your test preparation needs. If you have any questions or require further assistance, please do not hesitate to contact us.</p>
          <p>📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494</p>
          <p>We wish you the best for your mock test!</p>
          <p>Best regards,</p>
          <p>The Luminedge Team</p>
        </div>
      `;

    const emailResult = await emailSender(subject, user.email, messageContent);
    logEmailOutcome(
      `Booking confirmation email to ${user.email} (primary booking operation completed successfully)`,
      emailResult
    );
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

const normalize = (v) => (v ?? "").toString().trim().toLowerCase();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Home eligibility is a per-course allow-list of systems (`homeBasedSystems`),
// e.g. ["Computer-Based"]:
//  - field absent            => allowed for any system (default, unchanged)
//  - present, a booking value listed => allowed
//  - present, none listed / [] => blocked (empty list blocks every system)
//
// The "Computer-Based"/"Paper-Based" value may arrive on either `testSystem` or
// `testType` depending on the client, so we test BOTH candidate fields and allow
// when either matches the list. This is robust to which field carries it: a
// Computer-Based booking carries that string in one of them (=> allowed), a
// Paper-Based booking never does (=> blocked), and empty-list courses match
// nothing (=> always blocked) regardless of the field.
const isHomeBookingAllowed = (course, candidateSystems) => {
  if (!course || !Array.isArray(course.homeBasedSystems)) return true;
  const allowed = new Set(course.homeBasedSystems.map(normalize));
  return candidateSystems.some((v) => normalize(v) && allowed.has(normalize(v)));
};

// FIX-02a / FIX-02b — cancellation is a soft, auditable state change.
//
// A cancelled booking is retained (admin history + TRF/feedback linkage) but
// must never take part in an "active booking" decision: duplicate detection,
// per-course entitlement usage, rosters, attendance or TRF lookups.
//
// Two details are easy to get wrong in this data model:
//  - `status` already doubles as the attendance mirror: the attendance route
//    writes "Present"/"Absent" into it, while booking creation writes
//    "pending". So attendance can be signalled by `attendance` or by `status`.
//  - historical rows may hold either casing ("present" or "Present"), so every
//    attendance test here is case-insensitive.
const CANCELLED_STATUS = "cancelled";
const RECORDED_ATTENDANCE_PATTERN = /^(present|absent)$/i;

// Filter fragment for queries that must only consider still-active bookings.
const ACTIVE_BOOKING_FILTER = { status: { $ne: CANCELLED_STATUS } };

// Filter fragment for the single transition into "cancelled". It is applied as
// a conditional update so the claim is atomic: a booking that is already
// cancelled, or that has recorded attendance, can never be claimed twice.
const CANCELLABLE_BOOKING_FILTER = {
  status: { $ne: CANCELLED_STATUS, $not: RECORDED_ATTENDANCE_PATTERN },
  attendance: { $not: RECORDED_ATTENDANCE_PATTERN },
};

/** True when the booking has already been cancelled (any casing). */
const isCancelledBooking = (booking) =>
  normalize(booking && booking.status) === CANCELLED_STATUS;

/** True when attendance is recorded on either the `attendance` or `status` field. */
const hasRecordedAttendance = (booking) =>
  !!booking &&
  (RECORDED_ATTENDANCE_PATTERN.test((booking.attendance ?? "").toString().trim()) ||
    RECORDED_ATTENDANCE_PATTERN.test((booking.status ?? "").toString().trim()));

// D3-R08 / D3-R09 — cancellation may only restore a seat it can actually find
// and justify. These are the controlled conflict messages; each one is paired
// with a full abort of the cancellation transaction, so a rejected cancellation
// leaves the booking, the student's credit and every schedule counter untouched.
const CANCEL_LOCATION_UNKNOWN_MESSAGE =
  "This booking has no recognised location (Home or Test Center), so it cannot be cancelled safely. Nothing was changed.";
const CANCEL_SEAT_LINKAGE_MISSING_MESSAGE =
  "This Test Center booking is missing its schedule or time slot reference, so its seat cannot be returned. Nothing was changed.";
const CANCEL_SEAT_LINKAGE_INVALID_MESSAGE =
  "This Test Center booking has an invalid schedule reference, so its seat cannot be returned. Nothing was changed.";
const CANCEL_SCHEDULE_MISSING_MESSAGE =
  "The schedule for this booking no longer exists, so its seat cannot be returned. Nothing was changed.";
const CANCEL_SLOT_MISSING_MESSAGE =
  "The time slot for this booking no longer exists on its schedule, so its seat cannot be returned. Nothing was changed.";
const CANCEL_SLOT_AMBIGUOUS_MESSAGE =
  "This booking's time slot matches more than one slot on its schedule, so the seat cannot be returned safely. Nothing was changed.";
const CANCEL_SEAT_COUNTERS_INVALID_MESSAGE =
  "The seat counters for this booking's time slot are missing or invalid, so the seat cannot be returned safely. Nothing was changed.";
const CANCEL_SLOT_AT_CAPACITY_MESSAGE =
  "This booking's time slot is already at or above its configured capacity, so returning a seat is not safe. Nothing was changed.";

const BOOKING_LOCATION_HOME = "home";
const BOOKING_LOCATION_TEST_CENTER = "test center";

/**
 * Classify the booking's location for cancellation purposes.
 *
 * D3-R08: a Test Center booking *must* release a seat. Treating incomplete or
 * unrecognised metadata as "Home" (the old behaviour) refunds the credit while
 * leaving the consumed seat behind, so anything that is not explicitly Home or
 * Test Center is refused instead.
 */
const classifyBookingLocation = (booking) => {
  const value = normalize(booking && booking.location);
  if (value === BOOKING_LOCATION_HOME) return BOOKING_LOCATION_HOME;
  if (value === BOOKING_LOCATION_TEST_CENTER) return BOOKING_LOCATION_TEST_CENTER;
  return null;
};

/**
 * A stored seat counter is only usable if it is a real, non-negative integer.
 * Strings, decimals, negatives, null and undefined are all data-integrity
 * problems: incrementing them would either throw mid-transaction or restore a
 * meaningless seat, so they are rejected instead of coerced.
 */
const asStoredSeatCount = (value) =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * D3-R08 + D3-R09 — prove, inside the cancellation transaction, that exactly one
 * schedule slot is the seat this booking consumed and that restoring a seat to it
 * is arithmetically safe.
 *
 * Returns `{ ok: true, seatRestore }` where `seatRestore` carries the exact
 * element identity (`slotId` as stored) and the exact observed counter, so the
 * caller's conditional update can only ever touch that one element and only while
 * the counter still holds the value that was validated.
 *
 * Returns `{ ok: false, message, detail? }` for every unsafe case. Callers turn
 * that into a 409 and abort the transaction.
 */
async function resolveSeatRestoration({ booking, schedulesCollection, session }) {
  const rawScheduleId = booking.scheduleId;
  const rawSlotId = booking.slotId;

  const hasScheduleId =
    rawScheduleId !== undefined && rawScheduleId !== null && String(rawScheduleId).trim() !== "";
  const hasSlotId =
    rawSlotId !== undefined && rawSlotId !== null && String(rawSlotId).trim() !== "";

  if (!hasScheduleId || !hasSlotId) {
    return { ok: false, message: CANCEL_SEAT_LINKAGE_MISSING_MESSAGE };
  }

  // Legacy references may be strings or ObjectIds; anything else is not a
  // schedule reference at all.
  const scheduleIdHex = String(rawScheduleId).trim();
  if (!/^[0-9a-fA-F]{24}$/.test(scheduleIdHex)) {
    return { ok: false, message: CANCEL_SEAT_LINKAGE_INVALID_MESSAGE };
  }
  const scheduleObjectId = new ObjectId(scheduleIdHex);

  const schedule = await schedulesCollection.findOne({ _id: scheduleObjectId }, { session });
  if (!schedule) {
    return { ok: false, message: CANCEL_SCHEDULE_MISSING_MESSAGE };
  }

  // slotId is a string for everything created by this API but historical rows
  // may hold a number, so compare the normalised text form and then re-use the
  // *stored* value in the update predicate.
  const wantedSlotId = String(rawSlotId).trim();
  const timeSlots = Array.isArray(schedule.timeSlots) ? schedule.timeSlots : [];
  const matches = timeSlots.filter(
    (slot) =>
      slot &&
      slot.slotId !== undefined &&
      slot.slotId !== null &&
      String(slot.slotId).trim() === wantedSlotId
  );

  if (matches.length === 0) {
    return { ok: false, message: CANCEL_SLOT_MISSING_MESSAGE };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: CANCEL_SLOT_AMBIGUOUS_MESSAGE,
      detail: { scheduleId: scheduleIdHex, slotId: wantedSlotId, matches: matches.length },
    };
  }

  const slot = matches[0];
  const available = asStoredSeatCount(slot.slot);
  const capacity = asStoredSeatCount(slot.totalSlot);

  // No invented defaults: a slot without a usable capacity cannot justify a
  // restore. `capacity < 1` means the schedule can never have sold a seat here.
  if (available === null || capacity === null || capacity < 1) {
    return {
      ok: false,
      message: CANCEL_SEAT_COUNTERS_INVALID_MESSAGE,
      detail: {
        scheduleId: scheduleIdHex,
        slotId: wantedSlotId,
        slot: slot.slot,
        totalSlot: slot.totalSlot,
      },
    };
  }

  // 0 <= available < capacity is the invariant. At or above capacity means the
  // counters are already inconsistent (the direction the historical R07 defect
  // pushed them) and one more seat would let the slot oversell.
  if (available >= capacity) {
    return {
      ok: false,
      message: CANCEL_SLOT_AT_CAPACITY_MESSAGE,
      detail: { scheduleId: scheduleIdHex, slotId: wantedSlotId, slot: available, totalSlot: capacity },
    };
  }

  return {
    ok: true,
    seatRestore: { scheduleObjectId, slotId: slot.slotId, observedSlot: available },
  };
}

module.exports = ({ usersCollection, schedulesCollection, bookingMockCollection, coursesCollection, client }) => {
  // ---------------------------------------------------------------------------
  // FIX-04 — booking validation and eligibility (Home + Test Center)
  //
  // The gate below replaces a client-controlled, expiry-blind, case-sensitive
  // "purchased vs. lifetime-used" comparison that ran entirely outside the
  // transaction. It now enforces, in this order:
  //
  //   403  the target student's account status is `completed`
  //   400  the requested test instant parses as an exact Dhaka (UTC+06:00) time
  //   400  the test is in the future, and >= 24 h away for non-admin callers
  //   400  the course exists on the server and matches the request
  //   400  a verifiable, unexpired MR covers this course + mode at test start
  //   400  no active booking already holds that date/slot
  //
  // Entitlement is re-evaluated INSIDE the booking transaction against
  // session-consistent data, and the mock-credit claim is conditional on the
  // live account still being approved, so neither a stale approval nor a
  // concurrent booking can be turned into an extra booking.
  // ---------------------------------------------------------------------------
  const COMPLETED_STATUS = "completed";
  // Case-insensitive, whitespace-tolerant equivalent of `isCompletedAccount`,
  // used as an update predicate so the credit claim itself cannot succeed after
  // an account has been suspended in another request.
  const COMPLETED_STATUS_FILTER = { $regex: /^\s*completed\s*$/i };

  // One message for every entitlement failure: the caller learns "not
  // eligible", never which MR row or which internal reason (no oracle).
  const ENTITLEMENT_REJECTED_MESSAGE = "Insufficient mock tests available.";
  const ACCOUNT_NOT_APPROVED_MESSAGE =
    "Booking is only available for accounts with completed status.";
  const LEAD_TIME_MESSAGE = "Bookings must be made at least 24 hours before the test.";
  const PAST_TEST_MESSAGE = "The selected test time has already passed.";
  const INVALID_TEST_TIME_MESSAGE = "The selected booking date or test time is invalid.";
  const HOME_COURSE_UNVERIFIED_MESSAGE = "This course could not be verified. Please contact support.";
  const SCHEDULE_COURSE_UNVERIFIED_MESSAGE =
    "The course for this schedule could not be verified. Please contact support.";
  const SCHEDULE_UNAVAILABLE_MESSAGE = "This schedule is no longer available for booking.";
  const BOOKING_CONFLICT_MESSAGE = "Another booking for this account is in progress. Please try again.";
  // D4-R03 — an absent test type is not a mode. It used to normalise to "" and
  // match MR rows whose test type was also missing, authorising a booking on the
  // strength of two empty strings.
  const HOME_MODE_REQUIRED_MESSAGE = "Please select a valid test type for this Home test.";
  const SCHEDULE_MODE_UNVERIFIED_MESSAGE =
    "The test type for this schedule could not be verified. Please contact support.";

  const isCompletedAccount = (user) => normalize(user && user.status) === COMPLETED_STATUS;

  // D4-R02 — `users.mock` must be a whole number of credits before it can be
  // spent: `$inc` cannot decrement a string, and claiming a fractional balance
  // would leave a fractional (or negative) balance behind. "Insufficient" (0 or a
  // negative whole number) is ordinary and silent; anything else that fails the
  // whole-credit test is malformed data and is logged server-side.
  const isPlainInsufficientBalance = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value <= 0;

  /**
   * Course-document lookup under the documented normalisation. The only alias is
   * PTE === "Pearson PTE"; the returned document must normalise back to the
   * requested name, so an unrelated course can never satisfy a lookup.
   */
  const findCourseByName = async (rawName) => {
    const raw = String(rawName ?? "").trim();
    if (!raw) return null;
    const candidates = [raw];
    if (normalizeCourseName(raw) === "pearson pte") candidates.push("Pearson PTE", "PTE");
    const patterns = [...new Set(candidates)].map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
    const course = await coursesCollection.findOne({ name: { $in: patterns } });
    if (!course) return null;
    const stored = String(course.name ?? "").trim();
    if (!stored) return null;
    if (normalizeCourseName(stored) !== normalizeCourseName(raw)) return null;
    return course;
  };

  /**
   * Test Center course authority: the course document referenced by the
   * schedule. No fallback to `schedule.name` — an unresolvable reference is
   * refused so a schedule can never authorise a booking for a course that does
   * not exist in the course table.
   */
  const resolveScheduleCourse = async (schedule) => {
    const courseId = schedule && schedule.courseId;
    if (!courseId || !ObjectId.isValid(String(courseId))) {
      return { ok: false, reason: "invalid-course-reference" };
    }
    const course = await coursesCollection.findOne({ _id: new ObjectId(String(courseId)) });
    if (!course) return { ok: false, reason: "missing-course-document" };
    const name = String(course.name ?? "").trim();
    if (!name) return { ok: false, reason: "invalid-course-document" };
    return { ok: true, course, name };
  };

  /** Active booking history used by the entitlement reconstruction (no PII). */
  const activeBookingsFor = async (userId, session) => {
    const options = {
      projection: { name: 1, testType: 1, bookingDate: 1, testTime: 1, startTime: 1, status: 1 },
    };
    if (session) options.session = session;
    return bookingMockCollection.find({ userId, ...ACTIVE_BOOKING_FILTER }, options).toArray();
  };

  /**
   * A lost race on a shared document is reported as a conflict; anything else is
   * a genuine server failure and must stay a 5xx.
   */
  const isTransientTransactionError = (err) =>
    (typeof err?.hasErrorLabel === "function" && err.hasErrorLabel("TransientTransactionError")) ||
    err?.code === 112;

  router.post("/user/book-slot", verifyToken, async (req, res) => {
    try {
      // One clock read per request: every lead-time comparison below uses the
      // same instant, so a request can never straddle the 24-hour boundary.
      const requestNowMs = Date.now();
      const {
        scheduleId, userId, slotId, testType, testSystem,
        name, location, bookingDate, testTime,
      } = req.body;

      if (!userId || !location) {
        return res.status(400).json({
          message: "Missing required fields. 'userId' and 'location' are required.",
        });
      }

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user ID format." });
      }

      // A user can only book for themselves; admins can book for anyone
      if (req.user.role !== "admin" && userId !== String(req.user.userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      // D4-R02 — a balance must be at least one whole credit. A value such as 0.5
      // (or "2") used to pass `mock > 0` and then be decremented into a fractional
      // or untypeable balance; it is now refused before any state is touched.
      if (!user || !isWholeCreditBalance(user.mock)) {
        if (user && !isPlainInsufficientBalance(user.mock)) {
          console.warn(
            `FIX-04 booking rejected (D4-R02 invalid mock balance): ${JSON.stringify(user.mock)}`
          );
        }
        return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
      }

      // FIX-04 — only approved students may book. The check is on the TARGET
      // account, not the caller: an admin booking on a student's behalf does not
      // exempt that student. 403 keeps "not approved" distinct from
      // "no entitlement" (400).
      if (!isCompletedAccount(user)) {
        return res.status(403).json({ message: ACCOUNT_NOT_APPROVED_MESSAGE });
      }

      // Only a *verified* admin (live identity read in this request) may relax
      // the 24-hour lead time, and only that rule.
      const isVerifiedAdmin = req.user.role === "admin" && req.user.identityVerified === true;

      if (location === "Home") {
        if (!bookingDate || !testTime) {
          return res.status(400).json({ message: "Please select a booking date and test time." });
        }

        // FIX-04 — the course must resolve to a real course document, and its
        // canonical name is what gets stored. A client can therefore neither
        // invent a course nor cause the student's personal name to be stored in
        // the field the entitlement query itself filters on.
        const course = await findCourseByName(name);
        if (!course) {
          return res.status(400).json({ message: HOME_COURSE_UNVERIFIED_MESSAGE });
        }
        const canonicalCourse = String(course.name).trim();
        const canonicalMode = String(testType ?? "").trim();

        // D4-R03 — a Home booking must state a mode. Previously a missing
        // `testType` normalised to "" and then matched an MR row whose test type
        // was also missing, so two empty strings authorised a real booking.
        if (normalizeMode(canonicalMode) === "") {
          console.warn("FIX-04 booking rejected (D4-R03 missing Home test type)");
          return res.status(400).json({ message: HOME_MODE_REQUIRED_MESSAGE });
        }

        const normalizedCourse = normalizeCourseName(canonicalCourse);
        const normalizedMode = normalizeMode(canonicalMode);

        // FIX-04 — exact Dhaka (UTC+06:00) interpretation of the stored
        // wall-clock values, independent of the server timezone.
        const testStart = parseDhakaDateTime(bookingDate, testTime);
        if (!testStart.ok) {
          return res.status(400).json({ message: INVALID_TEST_TIME_MESSAGE });
        }

        const lead = evaluateLeadTime({
          testStartMs: testStart.ms,
          nowMs: requestNowMs,
          isVerifiedAdmin,
        });
        if (!lead.ok) {
          return res.status(400).json({
            message: lead.reason === "past" ? PAST_TEST_MESSAGE : LEAD_TIME_MESSAGE,
          });
        }

        // Enforce the course-level Home eligibility rule before touching any
        // state, so a rejected booking never decrements the user's mock count.
        // Center bookings are intentionally never gated by this.
        if (!isHomeBookingAllowed(course, [testSystem, canonicalMode])) {
          return res.status(400).json({
            message:
              "This course is not available for Home-based mock tests with the selected test system. Please book at a Test Center.",
          });
        }

        // FIX-04 — verifiable, unexpired MR for this exact course + mode at the
        // scheduled test start, renewal-aware (see utils/bookingEligibility).
        const entitlement = evaluateEntitlement({
          mocks: user.mocks,
          course: normalizedCourse,
          mode: normalizedMode,
          testStartMs: testStart.ms,
          bookings: await activeBookingsFor(userId),
        });
        if (!entitlement.eligible) {
          console.warn(`FIX-04 booking rejected (Home entitlement): ${entitlement.reason}`);
          return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
        }

        const existingBooking = await bookingMockCollection.findOne({
          userId, bookingDate, location: "Home", ...ACTIVE_BOOKING_FILTER,
        });

        if (existingBooking) {
          return res.status(400).json({ message: "You already have a test booked for this date." });
        }

        const bookingRecord = {
          userId, location: "Home", status: "pending",
          name: canonicalCourse, testType: canonicalMode,
          testSystem: testSystem || "N/A", bookingDate, testTime,
        };

        const homeSession = client.startSession();
        try {
          homeSession.startTransaction();

          // FIX-04 (correction C) — approval and entitlement are re-validated
          // against transaction-consistent data, and the credit claim is itself
          // conditional on the live account still being approved, so a stale
          // approval can never be turned into a booking.
          const freshUser = await usersCollection.findOne(
            { _id: new ObjectId(userId) },
            { session: homeSession }
          );
          if (!freshUser || !isCompletedAccount(freshUser)) {
            await homeSession.abortTransaction();
            return res.status(403).json({ message: ACCOUNT_NOT_APPROVED_MESSAGE });
          }

          // D4-R02 — re-validate the freshly read balance inside the transaction.
          // Only a whole number of credits may be spent, so the conditional claim
          // below can never leave a fractional or negative balance behind.
          if (!isWholeCreditBalance(freshUser.mock)) {
            console.warn(
              `FIX-04 booking rejected (D4-R02 in-transaction mock balance): ${JSON.stringify(freshUser.mock)}`
            );
            await homeSession.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          const freshEntitlement = evaluateEntitlement({
            mocks: freshUser.mocks,
            course: normalizedCourse,
            mode: normalizedMode,
            testStartMs: testStart.ms,
            bookings: await activeBookingsFor(userId, homeSession),
          });
          if (!freshEntitlement.eligible) {
            console.warn(
              `FIX-04 booking rejected (Home entitlement, in-transaction): ${freshEntitlement.reason}`
            );
            await homeSession.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          const racedDuplicate = await bookingMockCollection.findOne(
            { userId, bookingDate, location: "Home", ...ACTIVE_BOOKING_FILTER },
            { session: homeSession }
          );
          if (racedDuplicate) {
            await homeSession.abortTransaction();
            return res.status(400).json({ message: "You already have a test booked for this date." });
          }

          const updateMock = await usersCollection.updateOne(
            {
              _id: new ObjectId(userId),
              // D4-R02 — compare-and-set on the validated whole balance read in
              // this transaction, not a loose `$gt: 0`: a concurrent spend or a
              // fractional value can no longer be decremented, and the successful
              // `$inc: -1` always leaves a whole, non-negative number.
              mock: freshUser.mock,
              status: COMPLETED_STATUS_FILTER,
            },
            { $inc: { mock: -1 } },
            { session: homeSession }
          );

          if (updateMock.modifiedCount === 0) {
            await homeSession.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          await bookingMockCollection.insertOne(bookingRecord, { session: homeSession });
          await homeSession.commitTransaction();
        } catch (err) {
          if (homeSession.inTransaction()) {
            try { await homeSession.abortTransaction(); } catch {}
          }
          if (isTransientTransactionError(err)) {
            return res.status(409).json({ message: BOOKING_CONFLICT_MESSAGE });
          }
          throw err;
        } finally {
          try { await homeSession.endSession(); } catch {}
        }

        res.json({ success: true, message: "Home test booked successfully", bookingRecord });
        waitUntil(sendBookingConfirmationEmail(user, bookingRecord));
        return;
      }

      if (location === "Test Center") {
        if (!scheduleId || !slotId || !testType || !name) {
          return res.status(400).json({
            message: "Missing required fields: 'scheduleId', 'slotId', 'testType', and 'name' are required for Test Center bookings.",
          });
        }

        if (typeof testSystem === "string" && testSystem.trim() === "") {
          return res.status(400).json({
            message: "'testSystem' is required because a selection field was shown.",
          });
        }

        if (!ObjectId.isValid(scheduleId)) {
          return res.status(400).json({ message: "Invalid schedule ID format." });
        }

        const schedule = await schedulesCollection.findOne({ _id: new ObjectId(scheduleId) });
        if (!schedule) {
          return res.status(404).json({ message: "Schedule not found." });
        }

        // FIX-04 — a cancelled schedule must not accept new bookings.
        if (normalize(schedule.status) === CANCELLED_STATUS) {
          return res.status(400).json({ message: SCHEDULE_UNAVAILABLE_MESSAGE });
        }

        const selectedTimeSlot = schedule.timeSlots.find((slot) => slot.slotId === slotId);
        if (!selectedTimeSlot || Number(selectedTimeSlot.slot) < 1) {
          return res.status(400).json({ message: "Invalid or unavailable time slot selected." });
        }

        // FIX-04 — the schedule is the authority for course identity, not the
        // request body and not a free-text fallback.
        const scheduleCourse = await resolveScheduleCourse(schedule);
        if (!scheduleCourse.ok) {
          console.warn(`FIX-04 booking rejected (schedule course): ${scheduleCourse.reason}`);
          return res.status(400).json({ message: SCHEDULE_COURSE_UNVERIFIED_MESSAGE });
        }
        const canonicalCourse = scheduleCourse.name;
        if (normalizeCourseName(canonicalCourse) !== normalizeCourseName(name)) {
          return res.status(400).json({ message: SCHEDULE_COURSE_UNVERIFIED_MESSAGE });
        }

        // Mode: the schedule's own value wins where present, so a stale client
        // (which historically sent whichever MR row came first) cannot redefine
        // the mode of the test it is booking.
        const canonicalMode = String(schedule.testType ?? "").trim() || String(testType ?? "").trim();
        const normalizedCourse = normalizeCourseName(canonicalCourse);
        const normalizedMode = normalizeMode(canonicalMode);

        // D4-R03 — if neither the schedule nor the request can establish a test
        // type, fail safely instead of matching MR rows whose mode is also empty.
        if (normalizedMode === "") {
          console.warn("FIX-04 booking rejected (D4-R03 no verifiable Test Center test type)");
          return res.status(400).json({ message: SCHEDULE_MODE_UNVERIFIED_MESSAGE });
        }

        const testStart = parseDhakaDateTime(schedule.startDate, selectedTimeSlot.startTime);
        if (!testStart.ok) {
          return res.status(400).json({ message: INVALID_TEST_TIME_MESSAGE });
        }

        const lead = evaluateLeadTime({
          testStartMs: testStart.ms,
          nowMs: requestNowMs,
          isVerifiedAdmin,
        });
        if (!lead.ok) {
          return res.status(400).json({
            message: lead.reason === "past" ? PAST_TEST_MESSAGE : LEAD_TIME_MESSAGE,
          });
        }

        const entitlement = evaluateEntitlement({
          mocks: user.mocks,
          course: normalizedCourse,
          mode: normalizedMode,
          testStartMs: testStart.ms,
          bookings: await activeBookingsFor(userId),
        });
        if (!entitlement.eligible) {
          console.warn(`FIX-04 booking rejected (Test Center entitlement): ${entitlement.reason}`);
          return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
        }

        const existingBooking = await bookingMockCollection.findOne({
          userId, scheduleId, bookingDate: schedule.startDate, slotId, ...ACTIVE_BOOKING_FILTER,
        });
        if (existingBooking) {
          return res.status(400).json({ message: "You have already booked a slot for this date." });
        }

        const session = client.startSession();
        let bookingRecord;

        try {
          session.startTransaction();

          // Guard the decrement with slot > 0 so it's atomic: under concurrent
          // bookings for the last open seat, only one request's updateOne can
          // match-and-decrement — the loser sees modifiedCount 0 instead of
          // both succeeding and pushing slot negative (oversold seat).
          //
          // R07 (pre-existing defect corrected on Day 3): the guard used to be a
          // second *separate* predicate on the same array
          // (`"timeSlots.slotId": slotId, "timeSlots.slot": { $gt: 0 }`). With
          // two array predicates the positional `$` is ambiguous, and the driver
          // binds it to the element matching the FIRST predicate that matches —
          // which decremented `timeSlots.0` instead of the chosen slot. Every
          // Test Center booking therefore reduced the availability of the
          // *first* slot and left the booked slot untouched, corrupting per-slot
          // availability and breaking the "one booking, one seat" invariant that
          // cancellation restores. `$elemMatch` binds the predicate to a single
          // array element, so `$` deterministically refers to the booked slot and
          // the sold-out guard still refuses the decrement.
          const slotUpdate = await schedulesCollection.updateOne(
            {
              _id: new ObjectId(scheduleId),
              timeSlots: { $elemMatch: { slotId, slot: { $gt: 0 } } },
            },
            { $inc: { "timeSlots.$.slot": -1 } },
            { session }
          );
          if (slotUpdate.modifiedCount === 0) {
            await session.abortTransaction();
            return res.status(400).json({ message: "This time slot was just taken. Please pick another." });
          }

          // FIX-04 (correction C) — approval and entitlement are re-validated
          // against transaction-consistent data before the credit is claimed, so
          // a concurrent suspension or a concurrent booking cannot be converted
          // into an extra booking.
          const freshUser = await usersCollection.findOne(
            { _id: new ObjectId(userId) },
            { session }
          );
          if (!freshUser || !isCompletedAccount(freshUser)) {
            await session.abortTransaction();
            return res.status(403).json({ message: ACCOUNT_NOT_APPROVED_MESSAGE });
          }

          // D4-R02 — same whole-credit re-validation as the Home branch, against
          // transaction-consistent data.
          if (!isWholeCreditBalance(freshUser.mock)) {
            console.warn(
              `FIX-04 booking rejected (D4-R02 in-transaction mock balance): ${JSON.stringify(freshUser.mock)}`
            );
            await session.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          const freshEntitlement = evaluateEntitlement({
            mocks: freshUser.mocks,
            course: normalizedCourse,
            mode: normalizedMode,
            testStartMs: testStart.ms,
            bookings: await activeBookingsFor(userId, session),
          });
          if (!freshEntitlement.eligible) {
            console.warn(
              `FIX-04 booking rejected (Test Center entitlement, in-transaction): ${freshEntitlement.reason}`
            );
            await session.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          const racedDuplicate = await bookingMockCollection.findOne(
            { userId, scheduleId, bookingDate: schedule.startDate, slotId, ...ACTIVE_BOOKING_FILTER },
            { session }
          );
          if (racedDuplicate) {
            await session.abortTransaction();
            return res.status(400).json({ message: "You have already booked a slot for this date." });
          }

          const userUpdate = await usersCollection.updateOne(
            {
              _id: new ObjectId(userId),
              // D4-R02 — compare-and-set on the validated whole balance (see the
              // Home branch). The status predicate is unchanged.
              mock: freshUser.mock,
              status: COMPLETED_STATUS_FILTER,
            },
            { $inc: { mock: -1 } },
            { session }
          );
          if (userUpdate.modifiedCount === 0) {
            // A refused credit claim is a legitimate "not eligible" outcome (the
            // balance or the account changed under us), not a server failure.
            await session.abortTransaction();
            return res.status(400).json({ message: ENTITLEMENT_REJECTED_MESSAGE });
          }

          bookingRecord = {
            userId, scheduleId, slotId, status: "pending",
            name: canonicalCourse, testType: canonicalMode,
            testSystem: testSystem || null, bookingDate: schedule.startDate,
            startTime: selectedTimeSlot.startTime, endTime: selectedTimeSlot.endTime,
            location: "Test Center",
          };

          await bookingMockCollection.insertOne(bookingRecord, { session });

          await session.commitTransaction();
        } catch (err) {
          if (session.inTransaction()) {
            try { await session.abortTransaction(); } catch {}
          }
          // Two transactions racing on the SAME document (not just the same
          // slotId query) can also lose as a WriteConflict/TransientTransactionError
          // thrown straight out of updateOne, rather than as modifiedCount 0 above.
          // Treat that as a conflict, never as a server error.
          if (isTransientTransactionError(err)) {
            return res.status(409).json({ message: BOOKING_CONFLICT_MESSAGE });
          }
          throw err;
        } finally {
          try { await session.endSession(); } catch {}
        }

        // Email only after a committed transaction.
        res.json({ success: true, message: "Test Center test booked successfully", bookingRecord });
        waitUntil(sendBookingConfirmationEmail(user, bookingRecord));
      } else {
        return res.status(400).json({
          message: "Invalid location type. Must be 'Home' or 'Test Center'.",
        });
      }
    } catch (error) {
      console.error("Error booking slot:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // /send-reminder can be called two ways: normally, by an admin's browser
  // session (verifyAdmin), or as a self-continuation (see below) — a
  // server-to-server call this same route makes to itself when a recipient
  // list is too large to finish inside one invocation's time budget. The
  // continuation call carries a shared secret instead of an admin session,
  // since there is no browser/cookie involved.
  const SEND_REMINDER_CONTINUATION_HEADER = "x-internal-continuation-secret";

  function verifyAdminOrContinuation(req, res, next) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers[SEND_REMINDER_CONTINUATION_HEADER] === secret) {
      return next();
    }
    return verifyAdmin(req, res, next);
  }

  router.post("/send-reminder", verifyAdminOrContinuation, async (req, res) => {
    const { emails, continuationDepth } = req.body;

    if (!emails || !emails.length) {
      return res.status(400).json({ message: "No email data provided." });
    }

    try {
      // Bounded-concurrency send (emailSenderBulk caps in-flight SMTP connections
      // to match the pooled transporter's maxConnections) rather than a plain
      // Promise.all fan-out, which could exceed the SMTP host's concurrent-
      // connection limit and get sends rejected/throttled.
      const results = await emailSenderBulk(
        emails.map(({ email, subject, message }) => ({
          subject,
          to: email,
          content: message,
        }))
      );

      const sent = results.filter((r) => r.success).length;
      const failed = results.length - sent;
      // Recipients skipped because the bulk send-time budget ran out (as
      // opposed to a real delivery failure) — their original {email, subject,
      // message} entries are carried forward into a self-continuation call
      // below (not just reported), so a recipient list larger than one
      // invocation can process still gets fully sent without the admin having
      // to manually resubmit the leftovers.
      const skippedIndexes = results
        .map((r, i) => (r.error?.message === "Skipped: send time budget exceeded" ? i : -1))
        .filter((i) => i !== -1);
      const skippedRecipients = skippedIndexes.map((i) => emails[i]?.email).filter(Boolean);
      const skippedCount = skippedRecipients.length;

      // Reflect the real outcome in the status code so a client that keys off
      // HTTP status isn't told "success" when nothing was delivered:
      // all-failed -> 502, partial -> 207 (Multi-Status), all-sent -> 200.
      const status = sent === 0 ? 502 : failed > 0 ? 207 : 200;
      res.status(status).json({
        message: `Emails processed: ${sent} sent, ${failed} failed.`,
        sent,
        failed,
        skippedCount,
        skippedRecipients,
        continuing: skippedCount > 0,
      });

      if (skippedCount > 0) {
        // Hard cap on chain length so a bug (or a genuinely huge list) can
        // never loop forever — logs and stops instead of retrying forever.
        const MAX_CONTINUATION_DEPTH = 20;
        const depth = (continuationDepth || 0) + 1;

        if (depth > MAX_CONTINUATION_DEPTH) {
          console.error(
            `send-reminder: continuation depth limit (${MAX_CONTINUATION_DEPTH}) reached — ${skippedCount} recipient(s) never sent:`,
            skippedRecipients
          );
        } else if (!process.env.CRON_SECRET) {
          console.error(
            `send-reminder: CRON_SECRET is not set, cannot self-continue — ${skippedCount} recipient(s) were not sent:`,
            skippedRecipients
          );
        } else {
          const remainingEmails = skippedIndexes.map((i) => emails[i]);
          waitUntil(
            fetch(`${req.protocol}://${req.get("host")}/api/v1/send-reminder`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [SEND_REMINDER_CONTINUATION_HEADER]: process.env.CRON_SECRET,
              },
              body: JSON.stringify({ emails: remainingEmails, continuationDepth: depth }),
            }).catch((err) => console.error("send-reminder: continuation request failed:", err))
          );
        }
      }
    } catch (error) {
      console.error("Error sending emails:", error);
      res.status(500).json({ message: "Failed to send emails." });
    }
  });

  router.post("/user/attendance/bulk", verifyStaff, async (req, res) => {
    try {
      const { userIds } = req.body;
      if (!userIds || !Array.isArray(userIds)) {
        return res.status(400).json({ error: "Invalid userIds format" });
      }

      const attendanceData = await bookingMockCollection
        .aggregate([
          {
            $match: {
              userId: { $in: userIds },
              attendance: { $in: ["present", "absent"] },
              ...ACTIVE_BOOKING_FILTER,
            },
          },
          { $group: { _id: "$userId", count: { $sum: 1 } } },
        ], { maxTimeMS: 5000 })
        .toArray();

      const attendanceMap = attendanceData.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {});

      res.json({ attendance: attendanceMap });
    } catch (error) {
      console.error("Error fetching bulk attendance:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/user/bookings/:userId", verifyToken, async (req, res) => {
    const { userId } = req.params;

    const staffRoles = ["admin", "bdm", "teacher"];
    if (!staffRoles.includes(req.user.role) && userId !== String(req.user.userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const BOOKING_PROJECTION = {
      _id: 1, userId: 1, scheduleId: 1, slotId: 1, name: 1, testType: 1, testSystem: 1,
      location: 1, bookingDate: 1, testTime: 1, startTime: 1, endTime: 1,
      status: 1, attendance: 1, trfEmailed: 1, trfEmailAt: 1,
    };
    try {
      // Students see only live bookings. Cancelled rows are deliberately kept
      // in the database (see FIX-02a) and stay reachable through the
      // administrative history endpoint `GET /admin/bookings`.
      const bookings = await bookingMockCollection
        .find({ userId, ...ACTIVE_BOOKING_FILTER }, { projection: BOOKING_PROJECTION })
        .sort({ bookingDate: -1 })
        .toArray();
      res.json({ bookings });
    } catch (err) {
      console.error("Error fetching user bookings:", err);
      res.status(500).json({ message: "Failed to load bookings." });
    }
  });

  router.get("/admin/bookings/home-with-users", verifyStaff, async (req, res) => {
    try {
      const homeBookingsWithUsers = await bookingMockCollection
        .aggregate([
          { $match: { location: "Home", ...ACTIVE_BOOKING_FILTER } },
          { $addFields: { userObjectId: { $toObjectId: "$userId" } } },
          {
            $lookup: {
              from: "users",
              localField: "userObjectId",
              foreignField: "_id",
              as: "user",
            },
          },
          { $unwind: "$user" },
          {
            $project: {
              _id: 1, name: 1, testType: 1, testSystem: 1, location: 1,
              bookingDate: 1, testTime: 1, attendance: 1, userId: 1,
              "user._id": 1, "user.name": 1, "user.email": 1,
              "user.contactNo": 1, "user.transactionId": 1,
              "user.mock": 1, "user.totalMock": 1, "user.status": 1, "user.passportNumber": 1,
            },
          },
        ], { maxTimeMS: 9000 })
        .toArray();

      res.json({ bookings: homeBookingsWithUsers });
    } catch (error) {
      console.error("Error fetching optimized home bookings:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  });

  router.get("/admin/bookings/by-schedule/:scheduleId", verifyStaff, async (req, res, next) => {
    try {
      const scheduleId = String(req.params.scheduleId || "");
      if (!scheduleId) return res.status(400).json({ message: "scheduleId is required" });

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
      const skip = (page - 1) * limit;

      const projection = {
        _id: 1, id: 1, name: 1, testType: 1, testSystem: 1, bookingDate: 1,
        scheduleId: 1, slotId: 1, startTime: 1, endTime: 1, userId: 1,
        userCount: 1, attendance: 1,
      };

      const bookings = await bookingMockCollection
        .find({ scheduleId, ...ACTIVE_BOOKING_FILTER }, { projection })
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .maxTimeMS(8000)
        .toArray();

      return res.json({ bookings, page, limit });
    } catch (err) {
      if (err?.code === 50) {
        return res.status(504).json({ message: "Query took too long for this page/limit." });
      }
      next(err);
    }
  });

  router.get("/admin/bookings", verifyAdmin, async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
      const skip = (page - 1) * limit;

      const q = {};
      if (req.query.location) q.location = String(req.query.location);
      if (req.query.status) q.status = String(req.query.status);

      const projection = {
        _id: 1, userId: 1, scheduleId: 1, slotId: 1, name: 1, testType: 1, testSystem: 1,
        location: 1, bookingDate: 1, testTime: 1, startTime: 1, endTime: 1,
        status: 1, attendance: 1, trfEmailed: 1, trfEmailAt: 1,
      };

      const [bookings, total] = await Promise.all([
        bookingMockCollection
          .find(q, { projection })
          .sort({ _id: -1 })
          .skip(skip)
          .limit(limit)
          .maxTimeMS(9000)
          .toArray(),
        page === 1
          ? bookingMockCollection.countDocuments(q, { maxTimeMS: 5000 })
          : Promise.resolve(null),
      ]);

      if (bookings.length === 0 && page === 1) {
        return res.status(404).json({ message: "No bookings found" });
      }
      res.json({ bookings, ...(total !== null && { total }), page, limit });
    } catch (err) {
      if (err?.code === 50) {
        return res.status(504).json({ message: "Query took too long. Try a smaller page/limit." });
      }
      next(err);
    }
  });

  router.put("/user/bookings/:scheduleId", verifyAdmin, async (req, res) => {
    try {
      const { scheduleId } = req.params;
      const { userId, attendance, status, bookingDate } = req.body;

      if (!userId || !attendance || !status) {
        console.error("❌ Missing required fields:", { userId, attendance, status, bookingDate });
        return res.status(400).json({ message: "Missing required fields." });
      }

      let updateFilter = {};
      let schedule = null;
      let testDateFormatted;

      if (scheduleId.toLowerCase() === "home") {
        if (!bookingDate) {
          return res.status(400).json({ message: "Booking date is required for Home bookings." });
        }

        const bookingDateParsed = new Date(bookingDate);
        if (isNaN(bookingDateParsed.getTime())) {
          console.error("❌ Invalid bookingDate format:", bookingDate);
          return res.status(400).json({ message: "Invalid booking date format." });
        }

        updateFilter = { userId, location: "Home", bookingDate, ...ACTIVE_BOOKING_FILTER };
        testDateFormatted = bookingDateParsed.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        console.log("🔍 Searching for Home booking with:", updateFilter);
      } else {
        if (!ObjectId.isValid(scheduleId)) {
          console.error("❌ Invalid schedule ID format:", scheduleId);
          return res.status(400).json({ message: "Invalid schedule ID format." });
        }

        updateFilter = { scheduleId, userId, ...ACTIVE_BOOKING_FILTER };

        schedule = await schedulesCollection.findOne({ _id: new ObjectId(scheduleId) });
        if (!schedule) {
          return res.status(404).json({ message: "Schedule not found" });
        }

        testDateFormatted = new Date(schedule.startDate).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        console.log("🔍 Searching for Test Center booking with:", updateFilter);
      }

      const existingBooking = await bookingMockCollection.findOne(updateFilter);
      if (!existingBooking) {
        console.error("❌ Booking not found for update:", updateFilter);
        return res.status(404).json({ message: "Booking not found." });
      }

      const updateResult = await bookingMockCollection.updateOne(
        updateFilter,
        { $set: { status, attendance } }
      );

      if (updateResult.matchedCount === 0) {
        console.error("❌ No matching booking found:", updateFilter);
        return res.status(404).json({ message: "Booking not found." });
      }

      if (updateResult.modifiedCount === 0) {
        console.warn("⚠️ Booking found but attendance was not modified:", updateFilter);
        return res.status(200).json({ message: "Attendance already updated." });
      }

      console.log("✅ Attendance updated successfully for:", updateFilter);

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) {
        console.error("❌ User not found for email notification.");
        return res.status(404).json({ message: "User not found." });
      }

      let subject, messageContent;

      const safeUserName = sanitizeHtml(user.name || "Student", { allowedTags: [], allowedAttributes: {} });
      if (attendance === "present") {
        subject = "Thank You for Participating in Your Mock Test";
        messageContent = `
          <div>
            <p>Dear ${safeUserName},</p>
            <p>Thank you for attending your mock test on <strong>${testDateFormatted}</strong> at Luminedge! We hope the experience was helpful in assessing your preparation.</p>
            <p>Here are a few next steps to make the most of your mock test:</p>
            <ul>
              <li>Review your performance and identify improvement areas.</li>
              <li>Reach out to us if you need additional resources or support to enhance your preparation.</li>
            </ul>
            <p>Your insights help us improve our services. If you have any feedback about the test experience, feel free to share it with us at:</p>
            <p>📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494</p>
            <p>We wish you the best of luck as you continue your journey toward success!</p>
            <p>Best regards,</p>
            <p>The Luminedge Team</p>
          </div>
        `;
      } else if (attendance === "absent") {
        subject = "We Missed You at Your Mock Test";
        messageContent = `
          <div>
            <p>Dear ${safeUserName},</p>
            <p>We noticed that you couldn't attend your mock test scheduled on <strong>${testDateFormatted}</strong> at Luminedge! We understand that unexpected situations can arise, and we genuinely care about your preparation journey.</p>
            <p>Here are a few options to help you get back on track:</p>
            <ul>
              <li>Consider purchasing additional mock tests to continue your preparation journey.</li>
              <li>Reach out to our expert instructors for personalized guidance and strategies to enhance your test readiness.</li>
            </ul>
            <p>We're here to support you in achieving your goals. If you need assistance or have any questions, feel free to contact us at:</p>
            <p>📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494</p>
            <p>Your success is our priority, and we're committed to helping you every step of the way!</p>
            <p>Best regards,</p>
            <p>The Luminedge Team</p>
          </div>
        `;
      }

      res.json({
        success: true,
        message: `Attendance updated successfully for ${scheduleId.toLowerCase() === "home" ? "Home" : "Test Center"} booking.`,
      });

      waitUntil(
        emailSender(subject, user.email, messageContent).then((emailResult) =>
          logEmailOutcome(
            `Attendance email to ${user.email} (attendance record was still updated successfully)`,
            emailResult
          )
        )
      );
    } catch (error) {
      console.error("❌ Error updating attendance:", error);
      res.status(500).json({ message: "Error updating attendance" });
    }
  });

  // FIX-02a — cancellation is an administrative action.
  //
  // Previously this route was reachable by `verifyToken` and cancelled the
  // student's own booking by *deleting* it, which let a student restore their
  // own mock credit and destroyed the operating record. It is now:
  //  - admin-only (hardened `verifyAdmin`: token -> live identity -> role);
  //  - a soft cancellation that keeps the booking and records who/when;
  //  - refused once attendance exists, so a test that was sat is never refunded;
  //  - refused (409, full rollback) when a Test Center booking's seat linkage is
  //    missing, malformed, orphaned or ambiguous, or when the slot's counters
  //    cannot justify returning exactly one seat (D3-R08/D3-R09);
  //  - atomic: the status claim, the seat restore and the credit restore are one
  //    transaction, and the conditional claim is what makes the refund
  //    exactly-once under duplicate or concurrent cancellation.
  router.delete("/bookings/:bookingId", verifyAdmin, async (req, res) => {
    const { bookingId } = req.params;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking ID format." });
    }

    const session = client.startSession();
    try {
      session.startTransaction();

      const existingBooking = await bookingMockCollection.findOne(
        { _id: new ObjectId(bookingId) },
        { session }
      );
      if (!existingBooking) {
        await session.abortTransaction();
        return res.status(404).json({ message: "Booking not found." });
      }

      if (isCancelledBooking(existingBooking)) {
        await session.abortTransaction();
        return res.status(409).json({ message: "This booking has already been cancelled." });
      }

      if (hasRecordedAttendance(existingBooking)) {
        await session.abortTransaction();
        return res.status(409).json({
          message:
            "Attendance has already been recorded for this booking, so it cannot be cancelled or refunded.",
        });
      }

      // D3-R08 / D3-R09 — establish, before any write, that this booking's seat
      // (when it has one) can actually be returned and that returning it cannot
      // push the slot beyond its configured capacity. A failure here aborts with
      // 409: nothing is cancelled, refunded or incremented.
      const locationKind = classifyBookingLocation(existingBooking);
      if (!locationKind) {
        await session.abortTransaction();
        console.warn(
          `Cancel rejected: booking ${bookingId} has an unrecognised location (location=${JSON.stringify(
            existingBooking.location
          )})`
        );
        return res.status(409).json({ message: CANCEL_LOCATION_UNKNOWN_MESSAGE });
      }

      let seatRestore = null;
      if (locationKind === BOOKING_LOCATION_TEST_CENTER) {
        const seatCheck = await resolveSeatRestoration({
          booking: existingBooking,
          schedulesCollection,
          session,
        });
        if (!seatCheck.ok) {
          await session.abortTransaction();
          console.warn(
            `Cancel rejected: seat cannot be safely restored for booking ${bookingId} - ${seatCheck.message}`,
            seatCheck.detail || ""
          );
          return res.status(409).json({ message: seatCheck.message });
        }
        seatRestore = seatCheck.seatRestore;
      }

      // The one and only transition into "cancelled". The read checks above give
      // precise messages; this conditional update is the authority. A concurrent
      // canceller either loses the match here (matchedCount 0) or gets a write
      // conflict below, so the credit/seat restore can never run twice.
      const claimResult = await bookingMockCollection.updateOne(
        { _id: new ObjectId(bookingId), ...CANCELLABLE_BOOKING_FILTER },
        {
          $set: {
            status: CANCELLED_STATUS,
            cancelledAt: new Date(),
            cancelledBy: String(req.user.userId),
          },
        },
        { session }
      );

      if (claimResult.matchedCount !== 1) {
        await session.abortTransaction();
        return res.status(409).json({ message: "This booking is no longer cancellable." });
      }

      // D3-R09 — the restore is conditioned on the exact array element and the
      // exact counter value validated above. `$elemMatch` binds the positional
      // `$` to that single slot, and `slot: observedSlot` turns the increment
      // into a compare-and-set: if a concurrent booking/cancellation moved the
      // counter in between, the update matches nothing and the whole
      // cancellation rolls back instead of exceeding the configured capacity.
      //
      // Home bookings never reach this branch: they hold no seat, which is why
      // D3-R08 classifies the location explicitly instead of inferring "no
      // linkage means Home".
      if (seatRestore) {
        const seatResult = await schedulesCollection.updateOne(
          {
            _id: seatRestore.scheduleObjectId,
            timeSlots: {
              $elemMatch: { slotId: seatRestore.slotId, slot: seatRestore.observedSlot },
            },
          },
          { $inc: { "timeSlots.$.slot": 1 } },
          { session }
        );

        // A concurrent change is a known conflict (409) and the whole
        // transaction is rolled back, leaving the booking exactly as it was.
        if (seatResult.matchedCount !== 1) {
          await session.abortTransaction();
          console.warn(
            `Cancel aborted: seat could not be restored (scheduleId=${existingBooking.scheduleId}, slotId=${existingBooking.slotId})`
          );
          return res.status(409).json({
            message:
              "The schedule or time slot for this booking changed while it was being cancelled, so the seat could not be returned. Nothing was changed.",
          });
        }
      }

      const userUpdate = await usersCollection.updateOne(
        { _id: new ObjectId(existingBooking.userId) },
        { $inc: { mock: 1 } },
        { session }
      );

      if (userUpdate.matchedCount !== 1) {
        await session.abortTransaction();
        console.warn(`Warning: User mock count update failed for userId ${existingBooking.userId}`);
        return res.status(500).json({ message: "Failed to update mock count." });
      }

      await session.commitTransaction();

      res.json({
        success: true,
        message: "Booking canceled successfully, and mock count restored",
      });
    } catch (error) {
      if (session.inTransaction()) {
        try { await session.abortTransaction(); } catch {}
      }
      // A genuine write conflict means another request touched this booking,
      // schedule or user document at the same instant — that is a conflict, not
      // a server fault. Everything else (network, timeout, malformed data) stays
      // a 500 and is logged, rather than being reported as a conflict.
      if (error && error.code === 112) {
        console.warn("Cancel conflicted with a concurrent write; transaction rolled back:", error.message);
        return res.status(409).json({
          message: "This booking is being modified by another request. Nothing was changed.",
        });
      }
      console.error("Error canceling booking:", error);
      res.status(500).json({ message: "Internal server error" });
    } finally {
      await session.endSession();
    }
  });

  return router;
};
