// Stage 10.5 (D-031, closure patch) -- Booking (bookingMock collection)
// field normalizers plus one whole-document normalizer. No native TS
// repository exists for bookingMock yet (Booking stays fully legacy until
// Stage 11) -- these functions are built and unit-tested only, zero call
// sites, per the plan's scope.

import { ObjectId } from "mongodb";
import {
  coerceToCalendarDateString,
  coerceToCanonicalEnumValue,
  coerceToCanonicalIdString,
  coerceToObjectId,
  isPlainObject,
} from "./coercion";
import {
  fail,
  ok,
  type NormalizationChange,
  type NormalizationError,
  type NormalizationResult,
  type NormalizationWarning,
  type QuarantinedField,
} from "./migration.types";

export function normalizeBookingId(raw: unknown): NormalizationResult<ObjectId> {
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "bookingMock._id",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "_id must be a 24-char hex string or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(value, [], wasString ? [{ field: "bookingMock._id", observedType: "string", canonicalType: "objectId" }] : []);
}

export function normalizeBookingUserId(raw: unknown): NormalizationResult<ObjectId> {
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "bookingMock.userId",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "userId must be a 24-char hex string or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString ? [{ field: "bookingMock.userId", observedType: "string", canonicalType: "objectId" }] : []
  );
}

/** scheduleId is legitimately absent for Home bookings (confirmed:
 * booking.routes.js's Home-booking insert never sets it) -- undefined input
 * is NOT a reject, it is the expected Home-booking shape. */
export function normalizeBookingScheduleId(raw: unknown): NormalizationResult<ObjectId | undefined> {
  if (raw === undefined || raw === null) {
    return ok(undefined);
  }
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "bookingMock.scheduleId",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "scheduleId must be absent, a 24-char hex string, or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString ? [{ field: "bookingMock.scheduleId", observedType: "string", canonicalType: "objectId" }] : []
  );
}

/** slotId canonicalizes to STRING (matching schedules.timeSlots[].slotId --
 * see the locked contract), not number. Legitimately absent for Home
 * bookings, same as scheduleId. The 4 legacy integer docs get stringified. */
export function normalizeBookingSlotId(raw: unknown): NormalizationResult<string | undefined> {
  if (raw === undefined || raw === null) {
    return ok(undefined);
  }
  const value = coerceToCanonicalIdString(raw);
  if (value === undefined) {
    return fail([
      {
        field: "bookingMock.slotId",
        code: "INVALID_ID_STRING_SHAPE",
        message: "slotId must be absent, a non-empty string, or a finite number",
        observedType: typeof raw,
      },
    ]);
  }
  const wasNumber = typeof raw === "number";
  return ok(
    value,
    [],
    wasNumber ? [{ field: "bookingMock.slotId", observedType: "number", canonicalType: "string" }] : []
  );
}

/** Canonicalizes to a YYYY-MM-DD calendar string, NOT BSON Date --
 * consistent with Schedule.startDate/endDate's already-documented
 * string-boundary contract and the app's existing calendar-string usage.
 * The 2 legacy Date-typed docs get reformatted to the calendar-string form,
 * not promoted to canonical Date. */
export function normalizeBookingDate(raw: unknown): NormalizationResult<string> {
  const value = coerceToCalendarDateString(raw);
  if (value === undefined) {
    return fail([
      {
        field: "bookingMock.bookingDate",
        code: "INVALID_CALENDAR_DATE_SHAPE",
        message: "bookingDate must be a YYYY-MM-DD string, a parseable date string, or a Date",
        observedType: typeof raw,
      },
    ]);
  }
  const wasDate = raw instanceof Date;
  return ok(
    value,
    [],
    wasDate ? [{ field: "bookingMock.bookingDate", observedType: "date", canonicalType: "string" }] : []
  );
}

// Closure-patch correction: the user-supplied audit excerpt fully enumerates
// bookingMock.status across 100% of documents (20,911/20,911): Present
// (17,557), Absent (2,346), pending (763), completed (197), missed (46),
// "" (1), present (1). The enum is audit-confirmed COMPLETE -- this
// replaces the original Stage 10.5 3-way pass-through-with-warning policy
// with a closed accept/alias/reject policy.
const BOOKING_STATUS_CANONICAL_VALUES = ["Present", "Absent", "pending", "completed", "missed"] as const;
const BOOKING_STATUS_VARIANTS: Record<string, string> = {
  Present: "Present",
  present: "Present",
  Absent: "Absent",
  pending: "pending",
  completed: "completed",
  missed: "missed",
};

export function normalizeBookingStatus(raw: unknown): NormalizationResult<string> {
  if (typeof raw !== "string") {
    return fail([
      {
        field: "bookingMock.status",
        code: "INVALID_ENUM_SHAPE",
        message: "status must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if (raw === "") {
    return fail([
      {
        field: "bookingMock.status",
        code: "EMPTY_STATUS_VALUE",
        message: "status must not be an empty string",
        observedType: "string",
      },
    ]);
  }
  const known = coerceToCanonicalEnumValue(raw, BOOKING_STATUS_VARIANTS);
  if (known !== undefined) {
    const changes =
      raw === known
        ? []
        : [{ field: "bookingMock.status", observedType: `string:${raw}`, canonicalType: `string:${known}` }];
    return ok(known, [], changes);
  }
  return fail([
    {
      field: "bookingMock.status",
      code: "INVALID_STATUS_VALUE",
      message: `status is outside the audit-confirmed closed enum {${BOOKING_STATUS_CANONICAL_VALUES.join(", ")}} and its known alias`,
      observedType: "string",
    },
  ]);
}

// NEW (closure patch): bookingMock.testType. Audit-confirmed closed enum,
// same two values as schedules.testType but normalized independently (a
// different field on a different collection; no alias observed on the
// Booking side). Computer-Based (16,088) + Paper-Based (4,823) = 20,911 --
// 100% of bookingMock documents, so this field is required.
const BOOKING_TEST_TYPE_CANONICAL_VALUES = ["Computer-Based", "Paper-Based"] as const;

export function normalizeBookingTestType(raw: unknown): NormalizationResult<string> {
  if (typeof raw !== "string") {
    return fail([
      {
        field: "bookingMock.testType",
        code: "INVALID_ENUM_SHAPE",
        message: "testType must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if ((BOOKING_TEST_TYPE_CANONICAL_VALUES as readonly string[]).includes(raw)) {
    return ok(raw);
  }
  return fail([
    {
      field: "bookingMock.testType",
      code: "INVALID_ENUM_VALUE",
      message: `testType is outside the audit-confirmed closed enum {${BOOKING_TEST_TYPE_CANONICAL_VALUES.join(", ")}}`,
      observedType: "string",
    },
  ]);
}

// NEW (closure patch): bookingMock.location. Code-validated closed enum --
// booking.routes.js:110,158,228,320-323 explicitly 400s anything other than
// "Home"/"Test Center". Historically missing in some legacy documents (a
// genuine migration-completeness concern, not a shape error), so absence
// gets its own distinct code rather than being folded into a generic
// malformed-shape reject -- never defaulted.
const BOOKING_LOCATION_CANONICAL_VALUES = ["Home", "Test Center"] as const;

export function normalizeBookingLocation(raw: unknown): NormalizationResult<string> {
  if (raw === undefined || raw === null) {
    return fail([
      {
        field: "bookingMock.location",
        code: "MISSING_REQUIRED_FIELD",
        message: "location is required and must be one of {Home, Test Center}; absent in this document.",
        observedType: raw === null ? "null" : "undefined",
      },
    ]);
  }
  if (typeof raw !== "string") {
    return fail([
      {
        field: "bookingMock.location",
        code: "INVALID_ENUM_SHAPE",
        message: "location must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if ((BOOKING_LOCATION_CANONICAL_VALUES as readonly string[]).includes(raw)) {
    return ok(raw);
  }
  return fail([
    {
      field: "bookingMock.location",
      code: "INVALID_ENUM_VALUE",
      message: `location is outside the closed enum {${BOOKING_LOCATION_CANONICAL_VALUES.join(", ")}}`,
      observedType: "string",
    },
  ]);
}

/** Required-string check that distinguishes "field absent entirely" (a
 * historical-record migration-completeness concern) from "field present
 * but malformed" -- mirrors normalizeBookingLocation's split, scoped to
 * the specific required fields the closure-patch review raised
 * (bookingMock.name, users.name), not a blanket rewrite of every required
 * field in this module. */
function requireNonEmptyString(raw: unknown, field: string): { value?: string; error?: NormalizationError } {
  if (raw === undefined || raw === null) {
    return {
      error: { field, code: "MISSING_REQUIRED_FIELD", message: `${field} is required`, observedType: raw === null ? "null" : "undefined" },
    };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: { field, code: "INVALID_STRING_SHAPE", message: `${field} must be a non-empty string`, observedType: typeof raw } };
  }
  return { value: raw };
}

export interface CanonicalBooking {
  _id: ObjectId;
  userId: ObjectId;
  scheduleId?: ObjectId;
  slotId?: string;
  name: string;
  location: string;
  bookingDate: string;
  status: string;
  attendance?: string | null;
  testType: string;
  testSystem?: string | null;
  testTime?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  teacherL?: string | null;
  teacherLEmail?: string | null;
  teacherW?: string | null;
  teacherWEmail?: string | null;
  teacherR?: string | null;
  teacherREmail?: string | null;
  teacherS?: string | null;
  teacherSEmail?: string | null;
  trfEmailed?: boolean | null;
  trfEmailAt?: Date | null;
}

/** Semantic-consistency closure: an explicit `null` is preserved as `null`,
 * distinct from a genuinely absent (`undefined`) key -- "nullable: true" in
 * the contract is now semantically real rather than collapsing to the same
 * `undefined` output as absence. Direct evidence `null` is a real written
 * value for at least one of this helper's callers:
 * `booking.routes.js:294`'s `testSystem: testSystem || null`. */
function copyOptionalString(raw: unknown, field: string, errors: NormalizationError[]): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({ field, code: "INVALID_STRING_SHAPE", message: `${field} must be a string when present`, observedType: typeof raw });
    return undefined;
  }
  return raw;
}

function copyOptionalBoolean(raw: unknown, field: string, errors: NormalizationError[]): boolean | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "boolean") {
    errors.push({ field, code: "INVALID_BOOLEAN_SHAPE", message: `${field} must be a boolean when present`, observedType: typeof raw });
    return undefined;
  }
  return raw;
}

function copyOptionalDate(raw: unknown, field: string, errors: NormalizationError[]): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) {
    errors.push({ field, code: "INVALID_DATE_SHAPE", message: `${field} must be a Date when present`, observedType: typeof raw });
    return undefined;
  }
  return raw;
}

/** Explicitly constructs the canonical Booking document field-by-field from
 * the locked contract -- never spreads the raw input. Fields NOT declared in
 * the contract are dropped (field-leakage protection). */
export function normalizeBookingDocument(raw: unknown, sourceId?: string): NormalizationResult<CanonicalBooking> {
  if (!isPlainObject(raw)) {
    return fail(
      [
        {
          field: "bookingMock",
          code: "INVALID_DOCUMENT_SHAPE",
          message: "booking document must be a plain object",
          observedType: typeof raw,
          sourceId,
        },
      ],
      sourceId
    );
  }

  const errors: NormalizationError[] = [];
  const warnings: NormalizationWarning[] = [];
  const changes: NormalizationChange[] = [];
  const quarantined: QuarantinedField[] = [];

  const idResult = normalizeBookingId(raw._id);
  if (!idResult.ok) errors.push(...idResult.errors);

  const userIdResult = normalizeBookingUserId(raw.userId);
  if (!userIdResult.ok) errors.push(...userIdResult.errors);
  else {
    warnings.push(...userIdResult.warnings);
    changes.push(...userIdResult.changes);
  }

  const scheduleIdResult = normalizeBookingScheduleId(raw.scheduleId);
  if (!scheduleIdResult.ok) errors.push(...scheduleIdResult.errors);
  else {
    warnings.push(...scheduleIdResult.warnings);
    changes.push(...scheduleIdResult.changes);
  }

  const slotIdResult = normalizeBookingSlotId(raw.slotId);
  if (!slotIdResult.ok) errors.push(...slotIdResult.errors);
  else {
    warnings.push(...slotIdResult.warnings);
    changes.push(...slotIdResult.changes);
  }

  const bookingDateResult = normalizeBookingDate(raw.bookingDate);
  if (!bookingDateResult.ok) errors.push(...bookingDateResult.errors);
  else {
    warnings.push(...bookingDateResult.warnings);
    changes.push(...bookingDateResult.changes);
  }

  const statusResult = normalizeBookingStatus(raw.status);
  if (!statusResult.ok) errors.push(...statusResult.errors);
  else {
    warnings.push(...statusResult.warnings);
    changes.push(...statusResult.changes);
  }

  const name = requireNonEmptyString(raw.name, "bookingMock.name");
  if (name.error) errors.push(name.error);

  const locationResult = normalizeBookingLocation(raw.location);
  if (!locationResult.ok) errors.push(...locationResult.errors);

  const attendance = copyOptionalString(raw.attendance, "bookingMock.attendance", errors);

  const testTypeResult = normalizeBookingTestType(raw.testType);
  if (!testTypeResult.ok) errors.push(...testTypeResult.errors);
  else {
    warnings.push(...testTypeResult.warnings);
    changes.push(...testTypeResult.changes);
  }

  // testSystem: PRESERVE, optional/nullable, heterogeneous observed values
  // (Academic/TCY/Alfa/PowerPrep/AIWAS/General Training/Alpha/N/A + 569
  // nulls) -- not promoted to an enum, no alias fold invented.
  const testSystem = copyOptionalString(raw.testSystem, "bookingMock.testSystem", errors);
  const testTime = copyOptionalString(raw.testTime, "bookingMock.testTime", errors);
  const startTime = copyOptionalString(raw.startTime, "bookingMock.startTime", errors);
  const endTime = copyOptionalString(raw.endTime, "bookingMock.endTime", errors);
  const teacherL = copyOptionalString(raw.teacherL, "bookingMock.teacherL", errors);
  const teacherLEmail = copyOptionalString(raw.teacherLEmail, "bookingMock.teacherLEmail", errors);
  const teacherW = copyOptionalString(raw.teacherW, "bookingMock.teacherW", errors);
  const teacherWEmail = copyOptionalString(raw.teacherWEmail, "bookingMock.teacherWEmail", errors);
  const teacherR = copyOptionalString(raw.teacherR, "bookingMock.teacherR", errors);
  const teacherREmail = copyOptionalString(raw.teacherREmail, "bookingMock.teacherREmail", errors);
  const teacherS = copyOptionalString(raw.teacherS, "bookingMock.teacherS", errors);
  const teacherSEmail = copyOptionalString(raw.teacherSEmail, "bookingMock.teacherSEmail", errors);

  const trfEmailed = copyOptionalBoolean(raw.trfEmailed, "bookingMock.trfEmailed", errors);
  const trfEmailAt = copyOptionalDate(raw.trfEmailAt, "bookingMock.trfEmailAt", errors);

  // Undeclared-field leakage protection is implicit: only fields explicitly
  // read above are ever written into the canonical object below.

  if (errors.length > 0) {
    return fail(errors, sourceId);
  }

  return ok(
    {
      _id: (idResult as { ok: true; value: ObjectId }).value,
      userId: (userIdResult as { ok: true; value: ObjectId }).value,
      scheduleId: (scheduleIdResult as { ok: true; value: ObjectId | undefined }).value,
      slotId: (slotIdResult as { ok: true; value: string | undefined }).value,
      name: name.value as string,
      location: (locationResult as { ok: true; value: string }).value,
      bookingDate: (bookingDateResult as { ok: true; value: string }).value,
      status: (statusResult as { ok: true; value: string }).value,
      attendance,
      testType: (testTypeResult as { ok: true; value: string }).value,
      testSystem,
      testTime,
      startTime,
      endTime,
      teacherL,
      teacherLEmail,
      teacherW,
      teacherWEmail,
      teacherR,
      teacherREmail,
      teacherS,
      teacherSEmail,
      trfEmailed,
      trfEmailAt,
    },
    warnings,
    changes,
    quarantined
  );
}
