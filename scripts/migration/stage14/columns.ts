// Stage 14 -- the explicit column set of every table the ETL writes.
//
// Both sides of a reconciliation digest the SAME projected columns: the
// expected rows produced by the transform, and the rows read back from
// PostgreSQL. That makes the comparison independent of database defaults and
// of which columns the loader happened to supply.
//
// Mirrors prisma/schema/*.prisma (Stage 13). tests/migration/stage14 asserts
// that every transform row only uses columns listed here.

import { canonicalJson, shortDigest, type Row, type TableName } from "./common";

export interface TableSpec {
  /** Primary-key column (Prisma field name). */
  pk: string;
  columns: readonly string[];
}

export const TABLE_SPECS: Record<TableName, TableSpec> = {
  users: {
    pk: "id",
    columns: [
      "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "password", "role", "status",
      "isDeleted", "dateOfBirth", "contactNo", "passportNumber", "sex", "result", "mock", "totalMock", "mockType",
      "testSystem", "testType", "profileChangeRequestStatus", "profileEditNote", "needPasswordChange",
      "passwordChangedAt", "transactionId", "teacherLEmail", "teacherREmail", "teacherWEmail", "teacherSEmail",
      "lastTrfEmailAt", "budget",
    ],
  },
  courses: {
    pk: "id",
    columns: ["id", "name", "image", "homeBasedSystems", "createdAt", "updatedAt"],
  },
  schedules: {
    pk: "id",
    columns: ["id", "name", "courseId", "startDate", "endDate", "testType", "testSystem", "status", "createdAt"],
  },
  schedule_slots: {
    pk: "id",
    columns: ["id", "scheduleId", "position", "slotId", "seatsLeft", "capacityTotal", "startTime", "endTime"],
  },
  slot_counters: {
    pk: "scheduleId",
    columns: ["scheduleId", "nextN"],
  },
  mock_allocations: {
    pk: "id",
    columns: [
      "id", "userId", "transactionId", "mock", "mockType", "mrValidation", "mrValidationExpiry", "testSystem",
      "testType", "emailReminderSent", "createdAt", "updatedAt",
    ],
  },
  bookings: {
    pk: "id",
    columns: [
      "id", "userId", "scheduleId", "slotId", "name", "location", "bookingDate", "status", "attendance", "testType",
      "testSystem", "testTime", "startTime", "endTime", "teacherL", "teacherLEmail", "teacherR", "teacherREmail",
      "teacherW", "teacherWEmail", "teacherS", "teacherSEmail", "trfEmailed", "trfEmailAt",
    ],
  },
  teacher_assignments: {
    pk: "id",
    columns: [
      "id", "userId", "legacyKey", "bookingId", "scheduleId", "teacherL", "teacherLEmail", "teacherR",
      "teacherREmail", "teacherW", "teacherWEmail", "teacherS", "teacherSEmail",
    ],
  },
  feedback_entries: {
    pk: "id",
    columns: ["id", "userId", "legacyKey", "segment", "feedback", "marks", "admin", "recordedAt"],
  },
  feedback_status: {
    pk: "id",
    columns: ["id", "userId", "legacyKey", "segment", "complete"],
  },
  admin_sections: {
    pk: "id",
    columns: [
      "id", "userId", "legacyKey", "overallScore", "proficiencyLevel", "resultDate", "schemeCode", "adminComments",
      "adminSignature", "centreName", "testDate", "updatedAt",
    ],
  },
  trf_emails: {
    pk: "id",
    columns: ["id", "userId", "legacyKey", "lastSentAt", "lastSubject", "lastFilename", "toAddress"],
  },
  trf_email_history: {
    pk: "id",
    columns: ["id", "userId", "legacyKey", "sentAt", "subject", "filename", "toAddress"],
  },
};

export function rowKey(table: TableName, row: Row): string {
  return String(row[TABLE_SPECS[table].pk]);
}

/** Digest over exactly the table's columns. Absent and null digest identically (the documented NULL collapse). */
export function rowDigest(table: TableName, row: Row): string {
  const projected: Record<string, unknown> = {};
  for (const column of TABLE_SPECS[table].columns) {
    projected[column] = row[column] === undefined ? null : row[column];
  }
  return shortDigest(canonicalJson(projected));
}

/** Columns present on a row that the table spec does not know about (a transform bug). */
export function unknownColumns(table: TableName, row: Row): string[] {
  const known = new Set(TABLE_SPECS[table].columns);
  return Object.keys(row).filter((key) => !known.has(key));
}
