// Stage 14 -- User aggregate transform. Reuses normalizeUserDocument (Stage 10.5)
// for the root row, then derives the normalized child structures:
//
//   mocks[]                    -> mock_allocations      (one row per element)
//   resultsBySchedule          -> feedback_entries      (one row per array element)
//   feedbackStatusBySchedule   -> feedback_status       (one row per key+segment)
//   adminSectionBySchedule     -> admin_sections        (one row per key)
//   teachersBySchedule         -> teacher_assignments   (one row per key; key -> booking XOR schedule)
//   trfEmailsBySchedule        -> trf_emails + trf_email_history
//
// Every source unit becomes either a row or a QuarantineEntry carrying a reason
// code; the aggregate's independently-counted `sourceUnits` must balance
// (verified by the pipeline). Values are never copied into quarantine output.

import { normalizeUserDocument } from "../../../../tools/migration/user.normalizer";
import {
  canonicalHexId,
  containsNul,
  deterministicUuid,
  isRecord,
  readIntValue,
  readOptBoolean,
  readOptInstant,
  readOptInt,
  readOptString,
  sourceIdOf,
  toJsonValue,
  typeLabel,
  UnsupportedJsonValueError,
  type AggregateResult,
  type Finding,
  type JsonConversionStats,
  type QuarantineEntry,
  type RawDoc,
  type Read,
  type Row,
  type TableName,
  type TableRows,
} from "../common";
import type { PipelineState } from "../state";
import {
  DECLARED_ADMIN_SECTION_FIELDS,
  DECLARED_MOCK_ENTRY_FIELDS,
  DECLARED_RESULT_ENTRY_FIELDS,
  DECLARED_TEACHER_FIELDS,
  DECLARED_TRF_EMAIL_FIELDS,
  DECLARED_TRF_HISTORY_FIELDS,
  DECLARED_USER_FIELDS,
} from "./declared";

export const MAP_FIELDS = [
  "resultsBySchedule",
  "feedbackStatusBySchedule",
  "adminSectionBySchedule",
  "teachersBySchedule",
  "trfEmailsBySchedule",
] as const;
type MapField = (typeof MAP_FIELDS)[number];

const ADMIN_STRING_FIELDS = [
  "overallScore", "proficiencyLevel", "resultDate", "schemeCode", "adminComments", "adminSignature", "centreName", "testDate",
] as const;
const TEACHER_FIELDS = [
  "teacherL", "teacherLEmail", "teacherR", "teacherREmail", "teacherW", "teacherWEmail", "teacherS", "teacherSEmail",
] as const;

// ---------------------------------------------------------------------------
// Independent source-unit counting (from the RAW document)
// ---------------------------------------------------------------------------

function mapEntries(raw: RawDoc, field: MapField): Array<[string, unknown]> | "malformed" | "absent" {
  const value = raw[field];
  if (value === undefined || value === null) return "absent";
  if (!isRecord(value)) return "malformed";
  return Object.entries(value);
}

export function countUserUnits(raw: RawDoc): Partial<Record<TableName, number>> {
  const units: Partial<Record<TableName, number>> = {};
  const add = (kind: TableName, n: number): void => {
    units[kind] = (units[kind] ?? 0) + n;
  };

  if (Array.isArray(raw.mocks)) add("mock_allocations", raw.mocks.length);
  else if (raw.mocks !== undefined && raw.mocks !== null) add("mock_allocations", 1);

  const kindFor: Record<MapField, TableName> = {
    resultsBySchedule: "feedback_entries",
    feedbackStatusBySchedule: "feedback_status",
    adminSectionBySchedule: "admin_sections",
    teachersBySchedule: "teacher_assignments",
    trfEmailsBySchedule: "trf_emails",
  };
  for (const field of MAP_FIELDS) {
    const entries = mapEntries(raw, field);
    if (entries === "absent") continue;
    if (entries === "malformed") {
      add(kindFor[field], 1);
      continue;
    }
    for (const [, value] of entries) {
      if (field === "resultsBySchedule") add("feedback_entries", Array.isArray(value) ? value.length : 1);
      else if (field === "feedbackStatusBySchedule") add("feedback_status", isRecord(value) ? Object.keys(value).length : 1);
      else if (field === "trfEmailsBySchedule") {
        add("trf_emails", 1);
        if (isRecord(value) && value.history !== undefined && value.history !== null) {
          add("trf_email_history", Array.isArray(value.history) ? value.history.length : 1);
        }
      } else add(kindFor[field], 1);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type KeyResolution = { kind: "booking" | "schedule" } | { kind: "ambiguous" | "unresolved" };

export function resolveMapKey(key: string, state: PipelineState): KeyResolution {
  const hex = /^[0-9a-fA-F]{24}$/.test(key) ? key.toLowerCase() : undefined;
  const inBooking = hex !== undefined && state.keyIndex.bookings.has(hex);
  const inSchedule = hex !== undefined && state.keyIndex.schedules.has(hex);
  if (inBooking && inSchedule) return { kind: "ambiguous" };
  if (inBooking) return { kind: "booking" };
  if (inSchedule) return { kind: "schedule" };
  return { kind: "unresolved" };
}

class Builder {
  readonly rows: TableRows = {};
  readonly quarantines: QuarantineEntry[] = [];
  readonly findings: Finding[] = [];
  readonly jsonStats: JsonConversionStats = { dates: 0, objectIds: 0 };

  constructor(
    readonly userId: string,
    readonly state: PipelineState
  ) {}

  finding(code: string, scope: string, count = 1): void {
    this.findings.push({ code, scope, count });
  }

  quarantine(kind: TableName, scope: string, code: string, summary: string, opts: { units?: number; field?: string; observedType?: string } = {}): void {
    this.quarantines.push({
      entity: "users",
      kind,
      sourceId: this.userId,
      scope,
      code,
      field: opts.field,
      observedType: opts.observedType,
      summary,
      units: opts.units ?? 1,
    });
  }

  quarantineRead(kind: TableName, scope: string, failure: { code: string; field: string; observedType: string }, units = 1): void {
    this.quarantine(kind, scope, failure.code, `field value cannot be stored under the Stage 13 schema (${failure.code})`, {
      units,
      field: failure.field,
      observedType: failure.observedType,
    });
  }

  push(kind: TableName, scope: string, row: Row): void {
    if (Object.values(row).some(containsNul)) {
      this.quarantine(kind, scope, "NUL_CHARACTER_UNSUPPORTED", "a value contains a NUL character PostgreSQL cannot store");
      return;
    }
    (this.rows[kind] ??= []).push(row);
  }

  /** feedback / marks / result / budget passthrough. */
  json(value: unknown): { ok: true; value: unknown } | { ok: false; observedType: string } {
    if (value === undefined || value === null) return { ok: true, value: null };
    try {
      return { ok: true, value: toJsonValue(value, this.jsonStats) };
    } catch (error) {
      return { ok: false, observedType: error instanceof UnsupportedJsonValueError ? error.observedType : typeLabel(value) };
    }
  }
}

function readStrings<K extends string>(obj: RawDoc, keys: readonly K[]): { ok: true; values: Record<K, string | null> } | Extract<Read<never>, { ok: false }> {
  const values = {} as Record<K, string | null>;
  for (const key of keys) {
    const read = readOptString(obj, key);
    if (!read.ok) return read;
    values[key] = read.value;
  }
  return { ok: true, values };
}

function checkResolution(b: Builder, field: MapField, key: string, unitKind: TableName, units: number): KeyResolution | undefined {
  const resolution = resolveMapKey(key, b.state);
  if (resolution.kind === "booking" || resolution.kind === "schedule") {
    b.finding(resolution.kind === "booking" ? "KEY_RESOLVED_TO_BOOKING" : "KEY_RESOLVED_TO_SCHEDULE", field);
    return resolution;
  }
  const code = resolution.kind === "ambiguous" ? "AMBIGUOUS_SCHEDULE_KEY" : "UNRESOLVED_SCHEDULE_KEY";
  b.finding(resolution.kind === "ambiguous" ? "KEY_AMBIGUOUS" : "KEY_UNRESOLVED", field);
  b.quarantine(
    unitKind,
    `${field}.<key>`,
    code,
    resolution.kind === "ambiguous"
      ? "map key matches both a booking id and a schedule id"
      : "map key matches neither a source booking id nor a source schedule id",
    { units, field }
  );
  return undefined;
}

// ---- individual structures -------------------------------------------------

function buildMocks(b: Builder, mocks: unknown[]): void {
  mocks.forEach((entry, index) => {
    const scope = `mocks[${index}]`;
    if (!isRecord(entry)) {
      b.quarantine("mock_allocations", scope, "INVALID_DOCUMENT_SHAPE", "mocks[] element is not an object", { observedType: typeLabel(entry) });
      return;
    }
    b.state.noteUndeclared("users.mocks[]", entry, DECLARED_MOCK_ENTRY_FIELDS);
    const strings = readStrings(entry, ["transactionId", "mockType", "mrValidation", "testSystem", "testType"] as const);
    if (!strings.ok) return b.quarantineRead("mock_allocations", scope, strings);
    const mock = readOptInt(entry, "mock");
    if (!mock.ok) return b.quarantineRead("mock_allocations", scope, mock);
    const expiry = readOptInstant(entry, "mrValidationExpiry");
    if (!expiry.ok) return b.quarantineRead("mock_allocations", scope, expiry);
    const reminder = readOptBoolean(entry, "emailReminderSent");
    if (!reminder.ok) return b.quarantineRead("mock_allocations", scope, reminder);
    const createdAt = readOptInstant(entry, "createdAt");
    if (!createdAt.ok) return b.quarantineRead("mock_allocations", scope, createdAt);
    const updatedAt = readOptInstant(entry, "updatedAt");
    if (!updatedAt.ok) return b.quarantineRead("mock_allocations", scope, updatedAt);
    b.push("mock_allocations", scope, {
      id: deterministicUuid(`mock_allocation:${b.userId}:${index}`),
      userId: b.userId,
      transactionId: strings.values.transactionId,
      mock: mock.value,
      mockType: strings.values.mockType,
      mrValidation: strings.values.mrValidation,
      mrValidationExpiry: expiry.value,
      testSystem: strings.values.testSystem,
      testType: strings.values.testType,
      emailReminderSent: reminder.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    });
  });
}

function buildResults(b: Builder, entries: Array<[string, unknown]>): void {
  for (const [key, value] of entries) {
    const units = Array.isArray(value) ? value.length : 1;
    if (!checkResolution(b, "resultsBySchedule", key, "feedback_entries", units)) continue;
    if (!Array.isArray(value)) {
      b.quarantine("feedback_entries", `resultsBySchedule.${key}`, "INVALID_ARRAY_SHAPE", "results value is not an array", { observedType: typeLabel(value) });
      continue;
    }
    value.forEach((entry, index) => {
      const scope = `resultsBySchedule.${key}[${index}]`;
      if (!isRecord(entry)) {
        b.quarantine("feedback_entries", scope, "INVALID_DOCUMENT_SHAPE", "results element is not an object", { observedType: typeLabel(entry) });
        return;
      }
      b.state.noteUndeclared("users.resultsBySchedule[]", entry, DECLARED_RESULT_ENTRY_FIELDS);
      if (typeof entry.segment !== "string" || entry.segment.length === 0) {
        b.quarantine("feedback_entries", scope, "MISSING_REQUIRED_FIELD", "results element has no segment", { field: "segment", observedType: typeLabel(entry.segment) });
        return;
      }
      const admin = readOptString(entry, "admin");
      if (!admin.ok) return b.quarantineRead("feedback_entries", scope, admin);
      const recordedAt = readOptInstant(entry, "timestamp");
      if (!recordedAt.ok) return b.quarantineRead("feedback_entries", scope, recordedAt);
      const feedback = b.json(entry.feedback);
      if (!feedback.ok) return b.quarantineRead("feedback_entries", scope, { code: "UNSUPPORTED_BSON_TYPE", field: "feedback", observedType: feedback.observedType });
      const marks = b.json(entry.marks);
      if (!marks.ok) return b.quarantineRead("feedback_entries", scope, { code: "UNSUPPORTED_BSON_TYPE", field: "marks", observedType: marks.observedType });
      // feedback/marks polymorphism is contract-flagged QUARANTINE-for-review; it is
      // preserved verbatim as JSONB and its observed shape is reported.
      b.finding(`FEEDBACK_VALUE_TYPE_${typeLabel(entry.feedback)}`, "users.resultsBySchedule.feedback");
      b.finding(`MARKS_VALUE_TYPE_${typeLabel(entry.marks)}`, "users.resultsBySchedule.marks");
      b.push("feedback_entries", scope, {
        id: deterministicUuid(`feedback_entry:${b.userId}:${key}:${index}`),
        userId: b.userId,
        legacyKey: key,
        segment: entry.segment,
        feedback: feedback.value,
        marks: marks.value,
        admin: admin.value,
        recordedAt: recordedAt.value,
      });
    });
  }
}

function buildFeedbackStatus(b: Builder, entries: Array<[string, unknown]>): void {
  for (const [key, value] of entries) {
    const units = isRecord(value) ? Object.keys(value).length : 1;
    if (!checkResolution(b, "feedbackStatusBySchedule", key, "feedback_status", units)) continue;
    if (!isRecord(value)) {
      b.quarantine("feedback_status", `feedbackStatusBySchedule.${key}`, "INVALID_DOCUMENT_SHAPE", "status value is not an object", { observedType: typeLabel(value) });
      continue;
    }
    for (const [segment, flag] of Object.entries(value)) {
      const scope = `feedbackStatusBySchedule.${key}.${segment}`;
      if (typeof flag !== "boolean") {
        b.quarantine("feedback_status", scope, "INVALID_BOOLEAN_SHAPE", "segment completion flag is not a boolean", { field: segment, observedType: typeLabel(flag) });
        continue;
      }
      b.push("feedback_status", scope, {
        id: deterministicUuid(`feedback_status:${b.userId}:${key}:${segment}`),
        userId: b.userId,
        legacyKey: key,
        segment,
        complete: flag,
      });
    }
  }
}

function buildAdminSections(b: Builder, entries: Array<[string, unknown]>): void {
  for (const [key, value] of entries) {
    if (!checkResolution(b, "adminSectionBySchedule", key, "admin_sections", 1)) continue;
    const scope = `adminSectionBySchedule.${key}`;
    if (!isRecord(value)) {
      b.quarantine("admin_sections", scope, "INVALID_DOCUMENT_SHAPE", "admin section value is not an object", { observedType: typeLabel(value) });
      continue;
    }
    b.state.noteUndeclared("users.adminSectionBySchedule[]", value, DECLARED_ADMIN_SECTION_FIELDS);
    const strings = readStrings(value, ADMIN_STRING_FIELDS);
    if (!strings.ok) {
      b.quarantineRead("admin_sections", scope, strings);
      continue;
    }
    const updatedAt = readOptInstant(value, "updatedAt");
    if (!updatedAt.ok) {
      b.quarantineRead("admin_sections", scope, updatedAt);
      continue;
    }
    b.push("admin_sections", scope, {
      id: deterministicUuid(`admin_section:${b.userId}:${key}`),
      userId: b.userId,
      legacyKey: key,
      overallScore: strings.values.overallScore,
      proficiencyLevel: strings.values.proficiencyLevel,
      resultDate: strings.values.resultDate,
      schemeCode: strings.values.schemeCode,
      adminComments: strings.values.adminComments,
      adminSignature: strings.values.adminSignature,
      centreName: strings.values.centreName,
      testDate: strings.values.testDate,
      updatedAt: updatedAt.value,
    });
  }
}

function buildTeachers(b: Builder, entries: Array<[string, unknown]>): void {
  for (const [key, value] of entries) {
    const resolution = checkResolution(b, "teachersBySchedule", key, "teacher_assignments", 1);
    if (!resolution) continue;
    const scope = `teachersBySchedule.${key}`;
    if (!isRecord(value)) {
      b.quarantine("teacher_assignments", scope, "INVALID_DOCUMENT_SHAPE", "teacher assignment value is not an object", { observedType: typeLabel(value) });
      continue;
    }
    b.state.noteUndeclared("users.teachersBySchedule[]", value, DECLARED_TEACHER_FIELDS);
    const strings = readStrings(value, TEACHER_FIELDS);
    if (!strings.ok) {
      b.quarantineRead("teacher_assignments", scope, strings);
      continue;
    }
    const hex = key.toLowerCase();
    b.push("teacher_assignments", scope, {
      id: deterministicUuid(`teacher_assignment:${b.userId}:${key}`),
      userId: b.userId,
      legacyKey: key,
      bookingId: resolution.kind === "booking" ? hex : null,
      scheduleId: resolution.kind === "schedule" ? hex : null,
      ...strings.values,
    });
  }
}

function buildTrfEmails(b: Builder, entries: Array<[string, unknown]>): void {
  for (const [key, value] of entries) {
    const historyUnits = isRecord(value) && value.history !== undefined && value.history !== null ? (Array.isArray(value.history) ? value.history.length : 1) : 0;
    const resolved = resolveMapKey(key, b.state);
    if (resolved.kind === "ambiguous" || resolved.kind === "unresolved") {
      checkResolution(b, "trfEmailsBySchedule", key, "trf_emails", 1);
      if (historyUnits > 0) {
        b.quarantine("trf_email_history", `trfEmailsBySchedule.${key}.history`, resolved.kind === "ambiguous" ? "AMBIGUOUS_SCHEDULE_KEY" : "UNRESOLVED_SCHEDULE_KEY", "parent map key did not resolve", { units: historyUnits });
      }
      continue;
    }
    checkResolution(b, "trfEmailsBySchedule", key, "trf_emails", 1);
    const scope = `trfEmailsBySchedule.${key}`;
    const parentFailure = (code: string, summary: string, opts: { field?: string; observedType?: string }): void => {
      b.quarantine("trf_emails", scope, code, summary, opts);
      if (historyUnits > 0) b.quarantine("trf_email_history", `${scope}.history`, "PARENT_ROW_QUARANTINED", "its trf_emails row was quarantined", { units: historyUnits });
    };
    if (!isRecord(value)) {
      parentFailure("INVALID_DOCUMENT_SHAPE", "TRF email value is not an object", { observedType: typeLabel(value) });
      continue;
    }
    b.state.noteUndeclared("users.trfEmailsBySchedule[]", value, DECLARED_TRF_EMAIL_FIELDS);
    const strings = readStrings(value, ["lastSubject", "lastFilename", "to"] as const);
    if (!strings.ok) {
      b.quarantineRead("trf_emails", scope, strings);
      if (historyUnits > 0) b.quarantine("trf_email_history", `${scope}.history`, "PARENT_ROW_QUARANTINED", "its trf_emails row was quarantined", { units: historyUnits });
      continue;
    }
    const lastSentAt = readOptInstant(value, "lastSentAt");
    if (!lastSentAt.ok) {
      b.quarantineRead("trf_emails", scope, lastSentAt);
      if (historyUnits > 0) b.quarantine("trf_email_history", `${scope}.history`, "PARENT_ROW_QUARANTINED", "its trf_emails row was quarantined", { units: historyUnits });
      continue;
    }
    const before = b.quarantines.length;
    b.push("trf_emails", scope, {
      id: deterministicUuid(`trf_email:${b.userId}:${key}`),
      userId: b.userId,
      legacyKey: key,
      lastSentAt: lastSentAt.value,
      lastSubject: strings.values.lastSubject,
      lastFilename: strings.values.lastFilename,
      toAddress: strings.values.to,
    });
    if (b.quarantines.length > before && historyUnits > 0) {
      b.quarantine("trf_email_history", `${scope}.history`, "PARENT_ROW_QUARANTINED", "its trf_emails row was quarantined", { units: historyUnits });
      continue;
    }
    if (historyUnits === 0) continue;
    if (!Array.isArray(value.history)) {
      b.quarantine("trf_email_history", `${scope}.history`, "INVALID_ARRAY_SHAPE", "history is not an array", { observedType: typeLabel(value.history) });
      continue;
    }
    value.history.forEach((entry, index) => {
      const hScope = `${scope}.history[${index}]`;
      if (!isRecord(entry)) {
        b.quarantine("trf_email_history", hScope, "INVALID_DOCUMENT_SHAPE", "history element is not an object", { observedType: typeLabel(entry) });
        return;
      }
      b.state.noteUndeclared("users.trfEmailsBySchedule[].history[]", entry, DECLARED_TRF_HISTORY_FIELDS);
      const hs = readStrings(entry, ["subject", "filename", "to"] as const);
      if (!hs.ok) return b.quarantineRead("trf_email_history", hScope, hs);
      const sentAt = readOptInstant(entry, "at");
      if (!sentAt.ok) return b.quarantineRead("trf_email_history", hScope, sentAt);
      b.push("trf_email_history", hScope, {
        id: deterministicUuid(`trf_email_history:${b.userId}:${key}:${index}`),
        userId: b.userId,
        legacyKey: key,
        sentAt: sentAt.value,
        subject: hs.values.subject,
        filename: hs.values.filename,
        toAddress: hs.values.to,
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function transformUser(raw: RawDoc, state: PipelineState): AggregateResult {
  const sourceId = sourceIdOf(raw._id);
  const hexId = canonicalHexId(raw._id);
  if (hexId) state.sourceIds.users.add(hexId);
  if (hexId && typeof raw.email === "string") state.noteEmail(hexId, raw.email);
  state.noteUndeclared("users", raw, DECLARED_USER_FIELDS);

  const sourceUnits = countUserUnits(raw);

  const rejectRoot = (p: { code: string; summary: string; field?: string; observedType?: string }): AggregateResult => ({
    entity: "users",
    sourceId,
    sourceUnits,
    rootQuarantine: {
      entity: "users",
      kind: "users",
      sourceId,
      scope: "root",
      code: p.code,
      field: p.field,
      observedType: p.observedType,
      summary: p.summary,
      units: 1,
    },
    childQuarantines: [],
    findings: [],
  });

  const normalized = normalizeUserDocument(raw, sourceId);
  if (!normalized.ok) {
    const first = normalized.errors[0]!;
    return rejectRoot({
      code: first.code,
      summary: `normalizer rejected the user document (${normalized.errors.length} error(s))`,
      field: first.field,
      observedType: first.observedType,
    });
  }
  const u = normalized.value;
  const id = u._id.toHexString();

  if (state.acceptedUsers.has(id)) {
    return rejectRoot({ code: "DUPLICATE_CANONICAL_ID", summary: "another user document already resolved to this canonical id" });
  }

  const mock = readIntValue(u.mock, "users.mock");
  if (!mock.ok) return rejectRoot({ code: mock.code, summary: "mock counter is not a storable integer (never truncated)", field: mock.field, observedType: mock.observedType });
  const totalMock = readIntValue(u.totalMock, "users.totalMock");
  if (!totalMock.ok) return rejectRoot({ code: totalMock.code, summary: "totalMock counter is not a storable integer (never truncated)", field: totalMock.field, observedType: totalMock.observedType });

  const b = new Builder(id, state);

  const result = b.json(u.result);
  if (!result.ok) return rejectRoot({ code: "UNSUPPORTED_BSON_TYPE", summary: "result contains a value that cannot be stored as JSONB", field: "users.result", observedType: result.observedType });
  const budget = b.json(raw.budget);
  if (!budget.ok) return rejectRoot({ code: "UNSUPPORTED_BSON_TYPE", summary: "budget contains a value that cannot be stored as JSONB", field: "users.budget", observedType: budget.observedType });

  const userRow: Row = {
    id,
    name: u.name,
    email: u.email,
    emailVerified: false,
    image: null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    password: u.password,
    role: u.role,
    status: u.status,
    isDeleted: u.isDeleted,
    dateOfBirth: u.dateOfBirth ?? null,
    contactNo: u.contactNo ?? null,
    passportNumber: u.passportNumber ?? null,
    sex: u.sex ?? null,
    result: result.value,
    mock: mock.value,
    totalMock: totalMock.value,
    mockType: u.mockType ?? null,
    testSystem: u.testSystem ?? null,
    testType: u.testType ?? null,
    profileChangeRequestStatus: u.profileChangeRequestStatus ?? null,
    profileEditNote: u.profileEditNote ?? null,
    needPasswordChange: u.needPasswordChange ?? null,
    passwordChangedAt: u.passwordChangedAt ?? null,
    transactionId: u.transactionId ?? null,
    teacherLEmail: u.teacherLEmail ?? null,
    teacherREmail: u.teacherREmail ?? null,
    teacherWEmail: u.teacherWEmail ?? null,
    teacherSEmail: u.teacherSEmail ?? null,
    lastTrfEmailAt: u.lastTrfEmailAt ?? null,
    budget: budget.value,
  };
  if (Object.values(userRow).some(containsNul)) {
    return rejectRoot({ code: "NUL_CHARACTER_UNSUPPORTED", summary: "a value contains a NUL character PostgreSQL cannot store" });
  }
  b.rows.users = [userRow];

  if (u.mocks) buildMocks(b, u.mocks);
  const maps: Record<MapField, Array<[string, unknown]>> = {
    resultsBySchedule: u.resultsBySchedule ? Object.entries(u.resultsBySchedule) : [],
    feedbackStatusBySchedule: u.feedbackStatusBySchedule ? Object.entries(u.feedbackStatusBySchedule) : [],
    adminSectionBySchedule: u.adminSectionBySchedule ? Object.entries(u.adminSectionBySchedule) : [],
    teachersBySchedule: u.teachersBySchedule ? Object.entries(u.teachersBySchedule) : [],
    trfEmailsBySchedule: u.trfEmailsBySchedule ? Object.entries(u.trfEmailsBySchedule) : [],
  };
  buildResults(b, maps.resultsBySchedule);
  buildFeedbackStatus(b, maps.feedbackStatusBySchedule);
  buildAdminSections(b, maps.adminSectionBySchedule);
  buildTeachers(b, maps.teachersBySchedule);
  buildTrfEmails(b, maps.trfEmailsBySchedule);

  if (b.jsonStats.dates > 0) b.finding("JSONB_DATE_CONVERTED_TO_ISO_STRING", "users", b.jsonStats.dates);
  if (b.jsonStats.objectIds > 0) b.finding("JSONB_OBJECTID_CONVERTED_TO_HEX", "users", b.jsonStats.objectIds);

  state.acceptedUsers.add(id);
  return { entity: "users", sourceId: id, sourceUnits, rows: b.rows, childQuarantines: b.quarantines, findings: b.findings };
}
