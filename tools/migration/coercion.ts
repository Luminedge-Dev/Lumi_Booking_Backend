// Stage 10.5 (D-031) -- generic, entity-agnostic BSON-shape coercion
// primitives. These know nothing about User/Course/Schedule/Booking as
// domains; field-level meaning (which field, what it means when absent,
// what the reject condition is) lives in the per-entity *.normalizer.ts
// files, which compose these primitives.
//
// Each primitive returns `undefined` on an unrecognized shape rather than
// throwing -- the caller (a field-level normalizer) decides whether that is
// a NormalizationError (reject) or acceptable-as-optional.

import { ObjectId } from "mongodb";

export function coerceToObjectId(raw: unknown): ObjectId | undefined {
  if (raw instanceof ObjectId) return raw;
  if (typeof raw === "string" && ObjectId.isValid(raw)) return new ObjectId(raw);
  return undefined;
}

export function coerceToDateFromIso(raw: unknown): Date | undefined {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? undefined : raw;
  }
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

export function coerceToFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** For identifier-shaped fields that canonicalize to string even though a
 * minority of legacy documents store them as a number (e.g. slotId). */
export function coerceToCanonicalIdString(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Canonicalizes to a YYYY-MM-DD calendar string -- used for fields that
 * stay calendar-string typed (Booking.bookingDate), not fields that
 * canonicalize to BSON Date (createdAt/updatedAt). A BSON Date input is
 * reformatted to its UTC calendar-date string; a non-calendar-shaped date
 * string (e.g. a full ISO datetime) is re-parsed and reformatted the same
 * way; an already-canonical YYYY-MM-DD string passes through unchanged. */
export function coerceToCalendarDateString(raw: unknown): string | undefined {
  if (typeof raw === "string" && CALENDAR_DATE_PATTERN.test(raw)) return raw;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return undefined;
}

/** Whole-document normalizers (added in the Stage 10.5 closure patch) need
 * to validate the raw input is an object before reading fields off it. */
export function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

export function coerceToBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  return undefined;
}

/** Strict enum lookup: only returns a value for an EXACT key match in
 * `variants`. Field-level normalizers use this for the one evidenced
 * casing/spelling drift pair; they handle "recognized but uncharacterized"
 * string values themselves (see the 3-way enum policy documented in
 * schedule.normalizer.ts / booking.normalizer.ts) -- this primitive never
 * guesses or passes through on its own. */
export function coerceToCanonicalEnumValue<T extends string>(
  raw: unknown,
  variants: Record<string, T>
): T | undefined {
  if (typeof raw !== "string") return undefined;
  return variants[raw];
}
