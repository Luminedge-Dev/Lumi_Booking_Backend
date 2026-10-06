// Stage 10.5 (D-031) -- Course field normalizers. Course has 0 observed
// type inconsistencies (the cleanest collection, per Stage 6) -- this file
// only documents and validates the optional-presence of createdAt/updatedAt
// (present in 80% of the 5 total documents), it does not coerce between
// mixed BSON types since none were found.

import { ObjectId } from "mongodb";
import { coerceToDateFromIso, coerceToObjectId, isPlainObject } from "./coercion";
import {
  fail,
  ok,
  type NormalizationChange,
  type NormalizationError,
  type NormalizationResult,
  type NormalizationWarning,
  type QuarantinedField,
} from "./migration.types";

/** createdAt/updatedAt are optional (80% present) but, when present, must
 * be a valid date -- there is no observed alternate BSON type to fold. */
export function normalizeCourseTimestamp(field: "createdAt" | "updatedAt", raw: unknown): NormalizationResult<Date | undefined> {
  if (raw === undefined || raw === null) {
    return ok(undefined);
  }
  const value = coerceToDateFromIso(raw);
  if (value === undefined) {
    return fail([
      {
        field: `courses.${field}`,
        code: "INVALID_DATE_SHAPE",
        message: `${field} must be absent, an ISO date string, or a Date`,
        observedType: typeof raw,
      },
    ]);
  }
  const wasString = typeof raw === "string";
  return ok(
    value,
    [],
    wasString ? [{ field: `courses.${field}`, observedType: "string", canonicalType: "date" }] : []
  );
}

export interface CanonicalCourse {
  _id: ObjectId;
  name: string;
  image: string;
  homeBasedSystems: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

/** Explicitly constructs the canonical Course document field-by-field from
 * COURSE_CONTRACT -- never spreads the raw input. homeBasedSystems defaults
 * to [] when absent (a legitimate data-shape default, grounded in
 * scripts/unset-home-based-systems.js, not an invented business rule). */
export function normalizeCourseDocument(raw: unknown, sourceId?: string): NormalizationResult<CanonicalCourse> {
  if (!isPlainObject(raw)) {
    return fail(
      [
        {
          field: "courses",
          code: "INVALID_DOCUMENT_SHAPE",
          message: "course document must be a plain object",
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

  const id = coerceToObjectId(raw._id);
  if (id === undefined) {
    errors.push({ field: "courses._id", code: "INVALID_OBJECT_ID_SHAPE", message: "_id must be a 24-char hex string or an ObjectId", observedType: typeof raw._id });
  }

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : undefined;
  if (name === undefined) {
    errors.push({ field: "courses.name", code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: "name must be a non-empty string", observedType: typeof raw.name });
  }

  const image = typeof raw.image === "string" && raw.image.length > 0 ? raw.image : undefined;
  if (image === undefined) {
    errors.push({ field: "courses.image", code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: "image must be a non-empty string", observedType: typeof raw.image });
  }

  let homeBasedSystems: string[] | undefined;
  if (raw.homeBasedSystems === undefined || raw.homeBasedSystems === null) {
    homeBasedSystems = [];
    changes.push({ field: "courses.homeBasedSystems", observedType: "absent", canonicalType: "string[] (default [])" });
  } else if (Array.isArray(raw.homeBasedSystems) && raw.homeBasedSystems.every((entry) => typeof entry === "string")) {
    homeBasedSystems = raw.homeBasedSystems as string[];
  } else {
    errors.push({
      field: "courses.homeBasedSystems",
      code: "INVALID_ARRAY_SHAPE",
      message: "homeBasedSystems must be absent or an array of strings",
      observedType: typeof raw.homeBasedSystems,
    });
  }

  const createdAtResult = normalizeCourseTimestamp("createdAt", raw.createdAt);
  if (!createdAtResult.ok) errors.push(...createdAtResult.errors);
  else {
    warnings.push(...createdAtResult.warnings);
    changes.push(...createdAtResult.changes);
  }

  const updatedAtResult = normalizeCourseTimestamp("updatedAt", raw.updatedAt);
  if (!updatedAtResult.ok) errors.push(...updatedAtResult.errors);
  else {
    warnings.push(...updatedAtResult.warnings);
    changes.push(...updatedAtResult.changes);
  }

  // Undeclared-field leakage protection is implicit: only fields explicitly
  // read above are ever written into the canonical object below.

  if (errors.length > 0) {
    return fail(errors, sourceId);
  }

  return ok(
    {
      _id: id as ObjectId,
      name: name as string,
      image: image as string,
      homeBasedSystems: homeBasedSystems as string[],
      createdAt: (createdAtResult as { ok: true; value: Date | undefined }).value,
      updatedAt: (updatedAtResult as { ok: true; value: Date | undefined }).value,
    },
    warnings,
    changes,
    quarantined
  );
}
