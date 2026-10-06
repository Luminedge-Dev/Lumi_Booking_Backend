// Stage 10.5 (D-031, closure patch) -- User field normalizers plus one
// whole-document normalizer. users.mock/totalMock stay PRESERVE (not
// normalized, per Stage 6's explicit classification); the 3
// case-insensitive duplicate emails and the 4 unpopulated search-helper
// fields are explicitly NOT touched -- see user.contract.ts for their
// excluded entries. The five *BySchedule maps are PRESERVE: copied through
// as-is (object-shape checked only, never deep-validated per entry), their
// concrete sub-shapes are documented as TS types below and in
// context/canonical-data-contract.md, sourced from direct reads of
// feedback.routes.js.

import { ObjectId } from "mongodb";
import { coerceToObjectId, isPlainObject } from "./coercion";
import {
  fail,
  ok,
  type NormalizationChange,
  type NormalizationError,
  type NormalizationResult,
  type NormalizationWarning,
  type QuarantinedField,
} from "./migration.types";

export interface UserDateOfBirthSource {
  dateOfBirth?: unknown;
  dateofbirth?: unknown;
}

/** dateofbirth is a CODE-LEVEL ALIAS SPELLING, not an observed distinct
 * source-data BSON-type variant -- both keys, when present, are expected to
 * be strings; this function never encounters two DIFFERENT value shapes for
 * the "same" field the way e.g. bookingMock.bookingDate does.
 *
 * Semantic-consistency closure: an explicit `null` is a deliberate
 * canonical signal, preserved as `null` -- NOT collapsed to `undefined` the
 * way a genuinely absent key is. If the canonical `dateOfBirth` key is
 * explicitly `null`, that is the answer; the `dateofbirth` alias is only
 * consulted when `dateOfBirth` is truly `undefined` (absent). */
export function normalizeUserDateOfBirth(doc: UserDateOfBirthSource): NormalizationResult<string | null | undefined> {
  const canonical = doc.dateOfBirth;
  if (canonical === null) {
    return ok(null);
  }
  if (canonical !== undefined) {
    if (typeof canonical !== "string") {
      return fail([
        {
          field: "users.dateOfBirth",
          code: "INVALID_STRING_SHAPE",
          message: "dateOfBirth must be a string when present",
          observedType: typeof canonical,
        },
      ]);
    }
    return ok(canonical);
  }

  const alias = doc.dateofbirth;
  if (alias === null) {
    return ok(null);
  }
  if (alias !== undefined) {
    if (typeof alias !== "string") {
      return fail([
        {
          field: "users.dateofbirth",
          code: "INVALID_STRING_SHAPE",
          message: "dateofbirth must be a string when present",
          observedType: typeof alias,
        },
      ]);
    }
    return ok(alias, [], [{ field: "users.dateOfBirth", observedType: "alias:dateofbirth", canonicalType: "dateOfBirth" }]);
  }

  // Both genuinely absent -- legitimately optional, not an error.
  return ok(undefined);
}

export function normalizeUserId(raw: unknown): NormalizationResult<ObjectId> {
  const value = coerceToObjectId(raw);
  if (value === undefined) {
    return fail([
      {
        field: "users._id",
        code: "INVALID_OBJECT_ID_SHAPE",
        message: "_id must be a 24-char hex string or an ObjectId",
        observedType: typeof raw,
      },
    ]);
  }
  return ok(value);
}

// NEW (closure patch): users.role. Fully audit-evidenced closed enum
// (user 9,021 / teacher 16 / bdm 14 / admin 4 = 9,055, 100% of users) with
// no alias and no observed anomaly -- the simplest of the closed enums.
const USER_ROLE_CANONICAL_VALUES = ["user", "teacher", "bdm", "admin"] as const;

export function normalizeUserRole(raw: unknown): NormalizationResult<string> {
  if (typeof raw !== "string") {
    return fail([
      {
        field: "users.role",
        code: "INVALID_ENUM_SHAPE",
        message: "role must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if ((USER_ROLE_CANONICAL_VALUES as readonly string[]).includes(raw)) {
    return ok(raw);
  }
  return fail([
    {
      field: "users.role",
      code: "INVALID_ENUM_VALUE",
      message: `role is outside the audit-confirmed closed enum {${USER_ROLE_CANONICAL_VALUES.join(", ")}}`,
      observedType: "string",
    },
  ]);
}

// NEW (closure patch): users.status. Code-enforced closed enum
// (user.routes.js:206's ALLOWED_STATUSES) with one documented audited
// anomaly: a single legacy `null`. "blocked" is code-supported but has zero
// observed occurrences -- accepted on code evidence, same pattern as
// Schedule's "Cancelled". The one audited null is never defaulted to any
// canonical value.
const USER_STATUS_CANONICAL_VALUES = ["active", "checked", "completed", "blocked"] as const;

export function normalizeUserStatus(raw: unknown): NormalizationResult<string> {
  if (raw === null) {
    return fail([
      {
        field: "users.status",
        code: "NULL_STATUS_VALUE",
        message: "status is the known audited legacy-null document; never defaulted to a canonical value.",
        observedType: "null",
      },
    ]);
  }
  if (typeof raw !== "string") {
    return fail([
      {
        field: "users.status",
        code: "INVALID_ENUM_SHAPE",
        message: "status must be a string",
        observedType: typeof raw,
      },
    ]);
  }
  if ((USER_STATUS_CANONICAL_VALUES as readonly string[]).includes(raw)) {
    return ok(raw);
  }
  return fail([
    {
      field: "users.status",
      code: "UNCHARACTERIZED_ENUM_VALUE",
      message: "status value is not the code-enforced canonical set.",
      observedType: "string",
    },
  ]);
}

/** resultsBySchedule.<scheduleId>[] entry shape, sourced from
 * feedback.routes.js's push site. `feedback`/`marks` stay the one scoped
 * Mixed exception (Stage 6's own INVESTIGATE classification on exactly
 * these two sub-fields) -- not deep-validated by the document normalizer. */
export interface CanonicalFeedbackResultEntry {
  segment: "listening" | "reading" | "writing" | "speaking";
  feedback: unknown;
  marks: unknown;
  admin: string;
  timestamp: string;
}

export interface CanonicalFeedbackStatusEntry {
  listening?: boolean;
  reading?: boolean;
  writing?: boolean;
  speaking?: boolean;
}

export interface CanonicalAdminSectionEntry {
  overallScore?: unknown;
  proficiencyLevel?: unknown;
  resultDate?: unknown;
  schemeCode?: unknown;
  adminComments?: unknown;
  adminSignature?: unknown;
  centreName?: unknown;
  testDate: unknown;
  updatedAt: Date;
}

export interface CanonicalTrfEmailHistoryEntry {
  at: unknown;
  subject: unknown;
  filename: unknown;
  to: unknown;
}

export interface CanonicalTrfEmailEntry {
  lastSentAt: Date;
  lastSubject: string;
  lastFilename: string;
  to: string;
  history: CanonicalTrfEmailHistoryEntry[];
}

export interface CanonicalTeacherAssignmentEntry {
  teacherL?: string;
  teacherLEmail?: string;
  teacherW?: string;
  teacherWEmail?: string;
  teacherR?: string;
  teacherREmail?: string;
  teacherS?: string;
  teacherSEmail?: string;
}

/** users.mocks[] entry shape -- requiredness reflects the audited reality
 * that these 7 fields are consistently present per entry (even though the
 * server itself never validates them, since entries are spread verbatim
 * from admin-supplied req.body -- see user.routes.js:365-369). The
 * remaining 3 are genuinely optional: emailReminderSent is only set once a
 * reminder has fired (jobs/reminderCron.js:118); mrValidationExpiry/
 * updatedAt are only set by the later admin edit-mock endpoint
 * (user.routes.js:491-492), never at creation. */
export interface CanonicalUserMockEntry {
  createdAt: Date;
  mock: number;
  mockType: string;
  mrValidation: string;
  testSystem: string;
  testType: string;
  transactionId: string;
  emailReminderSent?: boolean;
  mrValidationExpiry?: string;
  updatedAt?: Date;
}

export interface CanonicalUser {
  _id: ObjectId;
  name: string;
  email: string;
  role: string;
  status: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  password: string;
  mock: number;
  totalMock: number;
  dateOfBirth?: string | null;
  contactNo?: string | null;
  passportNumber?: string | null;
  sex?: string | null;
  result?: unknown[] | null;
  mocks?: CanonicalUserMockEntry[];
  // Root-level legacy "mock fields <-> mocks[]" fallback fields (AGENTS.md
  // section 12). mrValidation is deliberately NOT included here: this
  // session's code search found only a fallback READ for a root-level
  // user.mrValidation (user.routes.js:572), never a write site -- the
  // audited database structure models mrValidation inside mocks[] only, so
  // a root-level mrValidation is a code-only compatibility read, not a
  // canonical persisted field.
  mockType?: string | null;
  testSystem?: string | null;
  testType?: string | null;
  profileChangeRequestStatus?: string | null;
  profileEditNote?: string | null;
  needPasswordChange?: boolean | null;
  passwordChangedAt?: Date | null;
  transactionId?: string | null;
  teacherLEmail?: string | null;
  teacherREmail?: string | null;
  teacherWEmail?: string | null;
  teacherSEmail?: string | null;
  lastTrfEmailAt?: Date | null;
  resultsBySchedule?: Record<string, CanonicalFeedbackResultEntry[]>;
  feedbackStatusBySchedule?: Record<string, CanonicalFeedbackStatusEntry>;
  adminSectionBySchedule?: Record<string, CanonicalAdminSectionEntry>;
  teachersBySchedule?: Record<string, CanonicalTeacherAssignmentEntry>;
  trfEmailsBySchedule?: Record<string, CanonicalTrfEmailEntry>;
}

/** Required-string check that distinguishes "field absent entirely" (a
 * historical-record migration-completeness concern) from "field present
 * but malformed" -- mirrors booking.normalizer.ts's
 * normalizeBookingLocation split, scoped to users.name per the
 * closure-patch review, not a blanket rewrite of every required field. */
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

function requireFiniteNumber(raw: unknown, field: string): { value?: number; error?: NormalizationError } {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { error: { field, code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: `${field} must be a finite number`, observedType: typeof raw } };
  }
  return { value: raw };
}

function requireDate(raw: unknown, field: string): { value?: Date; error?: NormalizationError } {
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) {
    return { error: { field, code: "MISSING_OR_INVALID_REQUIRED_FIELD", message: `${field} must be a Date`, observedType: typeof raw } };
  }
  return { value: raw };
}

/** Semantic-consistency closure: an explicit `null` is preserved as `null`,
 * distinct from a genuinely absent (`undefined`) key -- "nullable: true" in
 * the contract is now semantically real rather than collapsing to the same
 * `undefined` output as absence. */
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

/** Semantic-consistency closure (NEW): users.result's real legacy shape is
 * an array, corrected from an earlier, unverified "string" typing. No
 * element schema is invented -- entries pass through as `unknown`. `null`
 * is preserved distinctly from absence, same as the other nullable
 * helpers. */
function copyOptionalNullableArray(raw: unknown, field: string, errors: NormalizationError[]): unknown[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    errors.push({ field, code: "INVALID_ARRAY_SHAPE", message: `${field} must be an array when present`, observedType: typeof raw });
    return undefined;
  }
  return raw;
}

/** PRESERVE: copies a *BySchedule map through unchanged if it is a plain
 * object (or absent). Never deep-validates individual entries -- that is
 * what PRESERVE means (Stage 6 chose not to normalize these, only to stop
 * guessing their shape). */
function copyOptionalPreservedMap<T>(raw: unknown, field: string, errors: NormalizationError[]): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    errors.push({ field, code: "INVALID_DOCUMENT_SHAPE", message: `${field} must be a plain object when present`, observedType: typeof raw });
    return undefined;
  }
  return raw as T;
}

/** PRESERVE: copies an array-shaped field (users.mocks) through unchanged
 * if it is an array (or absent). Same non-deep-validation contract as
 * copyOptionalPreservedMap, just for an array instead of a map. */
function copyOptionalPreservedArray<T>(raw: unknown, field: string, errors: NormalizationError[]): T[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({ field, code: "INVALID_ARRAY_SHAPE", message: `${field} must be an array when present`, observedType: typeof raw });
    return undefined;
  }
  return raw as T[];
}

/** Explicitly constructs the canonical User document field-by-field from
 * USER_CONTRACT -- never spreads the raw input. Fields NOT declared in the
 * contract are dropped; `nameLower`/`emailLower`/`passportNumberLower`/
 * `transactionIdLower`/`resultsBySchedule.*.feedback`/`.marks`-adjacent
 * top-level INVESTIGATE fields are surfaced in `quarantined`;
 * `users." testType"` (IGNORE_AS_HISTORICAL) is omitted entirely. */
export function normalizeUserDocument(raw: unknown, sourceId?: string): NormalizationResult<CanonicalUser> {
  if (!isPlainObject(raw)) {
    return fail(
      [
        {
          field: "users",
          code: "INVALID_DOCUMENT_SHAPE",
          message: "user document must be a plain object",
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

  const idResult = normalizeUserId(raw._id);
  if (!idResult.ok) errors.push(...idResult.errors);

  const name = requireNonEmptyString(raw.name, "users.name");
  if (name.error) errors.push(name.error);

  // Semantic-consistency closure: email is REQUIRED, so it must reject an
  // explicit null the same as absence -- copyOptionalString's broadened
  // null-preserving contract is for truly optional/nullable fields only,
  // so required fields use requireNonEmptyString instead (same as name).
  const email = requireNonEmptyString(raw.email, "users.email");
  if (email.error) errors.push(email.error);

  const roleResult = normalizeUserRole(raw.role);
  if (!roleResult.ok) errors.push(...roleResult.errors);
  else {
    warnings.push(...roleResult.warnings);
    changes.push(...roleResult.changes);
  }

  const statusResult = normalizeUserStatus(raw.status);
  if (!statusResult.ok) errors.push(...statusResult.errors);
  else {
    warnings.push(...statusResult.warnings);
    changes.push(...statusResult.changes);
  }

  const isDeleted = typeof raw.isDeleted === "boolean" ? raw.isDeleted : raw.isDeleted === undefined ? false : undefined;
  if (isDeleted === undefined) {
    errors.push({ field: "users.isDeleted", code: "INVALID_BOOLEAN_SHAPE", message: "isDeleted must be a boolean", observedType: typeof raw.isDeleted });
  }

  const createdAt = requireDate(raw.createdAt, "users.createdAt");
  if (createdAt.error) errors.push(createdAt.error);
  const updatedAt = requireDate(raw.updatedAt, "users.updatedAt");
  if (updatedAt.error) errors.push(updatedAt.error);

  const password = requireNonEmptyString(raw.password, "users.password");
  if (password.error) errors.push(password.error);

  const mock = requireFiniteNumber(raw.mock, "users.mock");
  if (mock.error) errors.push(mock.error);
  const totalMock = requireFiniteNumber(raw.totalMock, "users.totalMock");
  if (totalMock.error) errors.push(totalMock.error);

  const dobResult = normalizeUserDateOfBirth({ dateOfBirth: raw.dateOfBirth, dateofbirth: raw.dateofbirth });
  if (!dobResult.ok) errors.push(...dobResult.errors);
  else {
    warnings.push(...dobResult.warnings);
    changes.push(...dobResult.changes);
  }

  const contactNo = copyOptionalString(raw.contactNo, "users.contactNo", errors);
  const passportNumber = copyOptionalString(raw.passportNumber, "users.passportNumber", errors);
  const sex = copyOptionalString(raw.sex, "users.sex", errors);
  const result = copyOptionalNullableArray(raw.result, "users.result", errors);
  const mocks = copyOptionalPreservedArray<CanonicalUserMockEntry>(raw.mocks, "users.mocks", errors);
  // Root-level legacy "mock fields <-> mocks[]" fallback reads (AGENTS.md
  // section 12) -- mockType/testSystem/testType only. mrValidation is
  // deliberately excluded: see the CanonicalUser interface's comment above.
  const mockType = copyOptionalString(raw.mockType, "users.mockType", errors);
  const testSystem = copyOptionalString(raw.testSystem, "users.testSystem", errors);
  const testType = copyOptionalString(raw.testType, "users.testType", errors);
  const profileChangeRequestStatus = copyOptionalString(raw.profileChangeRequestStatus, "users.profileChangeRequestStatus", errors);
  const profileEditNote = copyOptionalString(raw.profileEditNote, "users.profileEditNote", errors);

  const needPasswordChange = copyOptionalBoolean(raw.needPasswordChange, "users.needPasswordChange", errors);
  const passwordChangedAt = copyOptionalDate(raw.passwordChangedAt, "users.passwordChangedAt", errors);
  const transactionId = copyOptionalString(raw.transactionId, "users.transactionId", errors);
  const teacherLEmail = copyOptionalString(raw.teacherLEmail, "users.teacherLEmail", errors);
  const teacherREmail = copyOptionalString(raw.teacherREmail, "users.teacherREmail", errors);
  const teacherWEmail = copyOptionalString(raw.teacherWEmail, "users.teacherWEmail", errors);
  const teacherSEmail = copyOptionalString(raw.teacherSEmail, "users.teacherSEmail", errors);
  const lastTrfEmailAt = copyOptionalDate(raw.lastTrfEmailAt, "users.lastTrfEmailAt", errors);

  const resultsBySchedule = copyOptionalPreservedMap<Record<string, CanonicalFeedbackResultEntry[]>>(
    raw.resultsBySchedule,
    "users.resultsBySchedule",
    errors
  );
  const feedbackStatusBySchedule = copyOptionalPreservedMap<Record<string, CanonicalFeedbackStatusEntry>>(
    raw.feedbackStatusBySchedule,
    "users.feedbackStatusBySchedule",
    errors
  );
  const adminSectionBySchedule = copyOptionalPreservedMap<Record<string, CanonicalAdminSectionEntry>>(
    raw.adminSectionBySchedule,
    "users.adminSectionBySchedule",
    errors
  );
  const teachersBySchedule = copyOptionalPreservedMap<Record<string, CanonicalTeacherAssignmentEntry>>(
    raw.teachersBySchedule,
    "users.teachersBySchedule",
    errors
  );
  const trfEmailsBySchedule = copyOptionalPreservedMap<Record<string, CanonicalTrfEmailEntry>>(
    raw.trfEmailsBySchedule,
    "users.trfEmailsBySchedule",
    errors
  );

  // QUARANTINE: INVESTIGATE top-level fields are surfaced, never written
  // into the canonical object and never silently dropped.
  for (const field of ["nameLower", "emailLower", "passportNumberLower", "transactionIdLower"] as const) {
    const value = raw[field];
    if (value !== undefined) {
      quarantined.push({ field: `users.${field}`, observedType: typeof value, reason: "INVESTIGATE -- unpopulated legacy search-helper field" });
    }
  }
  // email itself stays INCLUDE; the case-insensitive-duplicate concern is
  // Stage 7/D-027 territory (authorization/uniqueness), not this stage's.

  // EXCLUDE: users." testType" (leading-space field, IGNORE_AS_HISTORICAL)
  // is simply never read above -- omitted from the canonical output.

  // Undeclared-field leakage protection is implicit: only fields explicitly
  // read above are ever written into the canonical object below.

  if (errors.length > 0) {
    return fail(errors, sourceId);
  }

  return ok(
    {
      _id: (idResult as { ok: true; value: ObjectId }).value,
      name: name.value as string,
      email: email.value as string,
      role: (roleResult as { ok: true; value: string }).value,
      status: (statusResult as { ok: true; value: string }).value,
      isDeleted: isDeleted as boolean,
      createdAt: createdAt.value as Date,
      updatedAt: updatedAt.value as Date,
      password: password.value as string,
      mock: mock.value as number,
      totalMock: totalMock.value as number,
      dateOfBirth: (dobResult as { ok: true; value: string | null | undefined }).value,
      contactNo,
      passportNumber,
      sex,
      result,
      mocks,
      mockType,
      testSystem,
      testType,
      profileChangeRequestStatus,
      profileEditNote,
      needPasswordChange,
      passwordChangedAt,
      transactionId,
      teacherLEmail,
      teacherREmail,
      teacherWEmail,
      teacherSEmail,
      lastTrfEmailAt,
      resultsBySchedule,
      feedbackStatusBySchedule,
      adminSectionBySchedule,
      teachersBySchedule,
      trfEmailsBySchedule,
    },
    warnings,
    changes,
    quarantined
  );
}
