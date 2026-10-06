// Stage 10.5 (D-031, closure patch) -- Schedule field normalizers plus one
// whole-document normalizer. Each field function covers exactly one field
// from the locked canonical contract (context/canonical-data-contract.md).
// Proven only against hand-built fixtures (tests/normalization/) -- never
// wired into src/app/modules/schedule/schedule.repository.ts this stage.

import { ObjectId } from "mongodb";
import {
  coerceToCanonicalEnumValue,
  coerceToCanonicalIdString,
  coerceToDateFromIso,
  coerceToFiniteNumber,
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

export function normalizeScheduleCreatedAt(raw: unknown): NormalizationResult<Date> {
  const value = coerceToDateFromIso(raw);
  if (value === undefined) {
    return fail([
      {
        field: "schedules.createdAt",
        code: "INVALID_DATE_SHAPE",
        message: "createdAt must be an ISO date string or a Date",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString ? [{ field: "schedules.createdAt", observedType: "string", canonicalType: "date" }] : []
  );
}

export function normalizeScheduleTotalSlot(raw: unknown): NormalizationResult<number> {
  const value = coerceToFiniteNumber(raw);
  if (value === undefined) {
    return fail([
      {
        field: "schedules.timeSlots[].totalSlot",
        code: "INVALID_NUMBER_SHAPE",
        message: "totalSlot must be a finite number or a numeric string",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString
      ? [{ field: "schedules.timeSlots[].totalSlot", observedType: "string", canonicalType: "number" }]
      : []
  );
}

export function normalizeScheduleCourseId(raw: unknown): NormalizationResult<ObjectId> {
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "schedules.courseId",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "courseId must be a 24-char hex string or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString ? [{ field: "schedules.courseId", observedType: "string", canonicalType: "objectId" }] : []
  );
}

export function normalizeScheduleId(raw: unknown): NormalizationResult<ObjectId> {
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "schedules._id",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "_id must be a 24-char hex string or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  return ok(value);
}

// Closure-patch correction: the audit (see context/canonical-data-contract.md
// and plan Context) fully enumerates schedules.testType as
// Computer-Based/Paper-Based -- the enum is audit-confirmed COMPLETE, not a
// partial casing-drift-only finding. This replaces the original Stage 10.5
// 3-way pass-through-with-warning policy with a closed accept/alias/reject
// policy: any value outside the two canonical values (or the one known
// casing alias) is now rejected, not passed through.
const SCHEDULE_TEST_TYPE_CANONICAL_VALUES = ["Computer-Based", "Paper-Based"] as const;
const SCHEDULE_TEST_TYPE_VARIANTS: Record<string, string> = {
  "Computer-Based": "Computer-Based",
  ComputerBased: "Computer-Based",
  "Paper-Based": "Paper-Based",
};

export function normalizeScheduleTestType(raw: unknown): NormalizationResult<string> {
  if (typeof raw !== "string") {
    return fail([
      {
        field: "schedules.testType",
        code: "INVALID_ENUM_SHAPE",
        message: "testType must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  const known = coerceToCanonicalEnumValue(raw, SCHEDULE_TEST_TYPE_VARIANTS);
  if (known !== undefined) {
    const changes =
      raw === known
        ? []
        : [{ field: "schedules.testType", observedType: `string:${raw}`, canonicalType: `string:${known}` }];
    return ok(known, [], changes);
  }
  return fail([
    {
      field: "schedules.testType",
      code: "INVALID_ENUM_VALUE",
      message: `testType is outside the audit-confirmed closed enum {${SCHEDULE_TEST_TYPE_CANONICAL_VALUES.join(", ")}} and its known alias`,
      observedType: `string`,
    },
  ]);
}

// NEW (closure patch): schedules.status. Unlike testType, the audit
// identifies a SPECIFIC documented historical anomaly rather than a fully
// clean closed set: Scheduled (2,383) and the 3 "pending" values that
// belong to the already-known, already-classified INVESTIGATE "3 flattened
// legacy schedules documents" (database-profile.md, canonical-data-
// contract.md). "Cancelled" is code-supported (schedule.routes.js:133's
// {$ne: "Cancelled"} query) but was not observed in this audit snapshot --
// accepted on code evidence, not excluded out of caution. Any OTHER value
// is a true unknown, kept distinct from the identified "pending" anomaly.
const SCHEDULE_STATUS_CANONICAL_VALUES = ["Scheduled", "Cancelled"] as const;
const SCHEDULE_STATUS_KNOWN_HISTORICAL_ANOMALY = "pending";

export function normalizeScheduleStatus(raw: unknown): NormalizationResult<string> {
  if (typeof raw !== "string") {
    return fail([
      {
        field: "schedules.status",
        code: "INVALID_ENUM_SHAPE",
        message: "status must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if ((SCHEDULE_STATUS_CANONICAL_VALUES as readonly string[]).includes(raw)) {
    return ok(raw);
  }
  if (raw === SCHEDULE_STATUS_KNOWN_HISTORICAL_ANOMALY) {
    return fail([
      {
        field: "schedules.status",
        code: "QUARANTINED_HISTORICAL_SCHEDULE_STATUS",
        message:
          '"pending" is the known historical-anomaly value belonging to the 3 flattened legacy schedules documents (see database-profile.md) -- not promoted into the canonical Schedule status enum.',
        observedType: "string",
      },
    ]);
  }
  return fail([
    {
      field: "schedules.status",
      code: "UNCHARACTERIZED_ENUM_VALUE",
      message: "status value is not the canonical/code-supported set or the one known historical anomaly.",
      observedType: "string",
    },
  ]);
}

export interface CanonicalScheduleTimeSlot {
  slot: number;
  slotId: string;
  totalSlot: number;
  startTime: string;
  endTime: string;
}

export interface CanonicalSchedule {
  _id: ObjectId;
  name: string;
  courseId: ObjectId;
  createdAt: Date;
  testType: string;
  testSystem?: string;
  status: string;
  startDate: string;
  endDate: string;
  timeSlots: CanonicalScheduleTimeSlot[];
}

function requireString(raw: unknown, field: string): { value?: string; error?: NormalizationError } {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      error: { field, code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: `${field} must be a non-empty string`, observedType: typeof raw },
    };
  }
  return { value: raw };
}

function requireFiniteNumber(raw: unknown, field: string): { value?: number; error?: NormalizationError } {
  const value = coerceToFiniteNumber(raw);
  if (value === undefined) {
    return {
      error: { field, code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: `${field} must be a finite number`, observedType: typeof raw },
    };
  }
  return { value };
}

/** Explicitly constructs the canonical Schedule document field-by-field from
 * SCHEDULE_CONTRACT -- never spreads the raw input. Fields NOT declared in
 * the contract are dropped (field-leakage protection); EXCLUDE fields are
 * omitted; QUARANTINE fields are surfaced in `quarantined`, never written
 * into the canonical object. */
export function normalizeScheduleDocument(raw: unknown, sourceId?: string): NormalizationResult<CanonicalSchedule> {
  if (!isPlainObject(raw)) {
    return fail(
      [
        {
          field: "schedules",
          code: "INVALID_DOCUMENT_SHAPE",
          message: "schedule document must be a plain object",
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

  const idResult = normalizeScheduleId(raw._id);
  if (!idResult.ok) errors.push(...idResult.errors);

  const name = requireString(raw.name, "schedules.name");
  if (name.error) errors.push(name.error);

  const courseIdResult = normalizeScheduleCourseId(raw.courseId);
  if (!courseIdResult.ok) errors.push(...courseIdResult.errors);
  else {
    warnings.push(...courseIdResult.warnings);
    changes.push(...courseIdResult.changes);
  }

  const createdAtResult = normalizeScheduleCreatedAt(raw.createdAt);
  if (!createdAtResult.ok) errors.push(...createdAtResult.errors);
  else {
    warnings.push(...createdAtResult.warnings);
    changes.push(...createdAtResult.changes);
  }

  const testTypeResult = normalizeScheduleTestType(raw.testType);
  if (!testTypeResult.ok) errors.push(...testTypeResult.errors);
  else {
    warnings.push(...testTypeResult.warnings);
    changes.push(...testTypeResult.changes);
  }

  // testSystem: PRESERVE, optional/nullable -- not an enum, just a
  // string-or-absent sentinel field per Stage 6's "don't collapse
  // sentinels" policy.
  let testSystem: string | undefined;
  if (raw.testSystem !== undefined && raw.testSystem !== null) {
    if (typeof raw.testSystem !== "string") {
      errors.push({
        field: "schedules.testSystem",
        code: "INVALID_STRING_SHAPE",
        message: "testSystem must be a string when present",
        observedType: typeof raw.testSystem,
      });
    } else {
      testSystem = raw.testSystem;
    }
  }

  const statusResult = normalizeScheduleStatus(raw.status);
  if (!statusResult.ok) errors.push(...statusResult.errors);
  else {
    warnings.push(...statusResult.warnings);
    changes.push(...statusResult.changes);
  }

  const startDate = requireString(raw.startDate, "schedules.startDate");
  if (startDate.error) errors.push(startDate.error);
  const endDate = requireString(raw.endDate, "schedules.endDate");
  if (endDate.error) errors.push(endDate.error);

  const timeSlots: CanonicalScheduleTimeSlot[] = [];
  if (!Array.isArray(raw.timeSlots)) {
    errors.push({
      field: "schedules.timeSlots",
      code: "MISSING_OR_INVALID_REQUIRED_FIELD",
      message: "timeSlots must be an array",
      observedType: typeof raw.timeSlots,
    });
  } else {
    raw.timeSlots.forEach((rawSlot, index) => {
      if (!isPlainObject(rawSlot)) {
        errors.push({
          field: `schedules.timeSlots[${index}]`,
          code: "INVALID_DOCUMENT_SHAPE",
          message: "timeSlots entry must be a plain object",
          observedType: typeof rawSlot,
        });
        return;
      }
      const slot = requireFiniteNumber(rawSlot.slot, `schedules.timeSlots[${index}].slot`);
      const slotIdValue = coerceToCanonicalIdString(rawSlot.slotId);
      const totalSlotResult = normalizeScheduleTotalSlot(rawSlot.totalSlot);
      const startTime = requireString(rawSlot.startTime, `schedules.timeSlots[${index}].startTime`);
      const endTime = requireString(rawSlot.endTime, `schedules.timeSlots[${index}].endTime`);

      if (slot.error) errors.push(slot.error);
      if (slotIdValue === undefined) {
        errors.push({
          field: `schedules.timeSlots[${index}].slotId`,
          code: "MISSING_OR_INVALID_REQUIRED_FIELD",
          message: "slotId must be a non-empty string or finite number",
          observedType: typeof rawSlot.slotId,
        });
      }
      if (!totalSlotResult.ok) errors.push(...totalSlotResult.errors);
      else {
        warnings.push(...totalSlotResult.warnings);
        changes.push(...totalSlotResult.changes);
      }
      if (startTime.error) errors.push(startTime.error);
      if (endTime.error) errors.push(endTime.error);

      if (
        slot.value !== undefined &&
        slotIdValue !== undefined &&
        totalSlotResult.ok &&
        startTime.value !== undefined &&
        endTime.value !== undefined
      ) {
        timeSlots.push({
          slot: slot.value,
          slotId: slotIdValue,
          totalSlot: totalSlotResult.value,
          startTime: startTime.value,
          endTime: endTime.value,
        });
      }
    });
  }

  // The 3 flattened legacy documents (SCHEDULE_CONTRACT's QUARANTINE entry)
  // are handled by this same required-field validation above -- they are
  // missing timeSlots/courseId/startDate, so they fail here with ok:false,
  // which is itself the quarantine signal; no separate code path is needed.

  // Undeclared-field leakage protection is implicit: only fields explicitly
  // read above are ever written into the canonical object below.

  if (errors.length > 0) {
    return fail(errors, sourceId);
  }

  return ok(
    {
      _id: (idResult as { ok: true; value: ObjectId }).value,
      name: name.value as string,
      courseId: (courseIdResult as { ok: true; value: ObjectId }).value,
      createdAt: (createdAtResult as { ok: true; value: Date }).value,
      testType: (testTypeResult as { ok: true; value: string }).value,
      testSystem,
      status: (statusResult as { ok: true; value: string }).value,
      startDate: startDate.value as string,
      endDate: endDate.value as string,
      timeSlots,
    },
    warnings,
    changes,
    quarantined
  );
}
