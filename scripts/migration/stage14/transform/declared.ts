// Stage 14 -- which top-level source fields the canonical contracts know about.
// Anything else seen in a source document is REPORTED (never silently dropped).

import type { FieldContractEntry } from "../../../../tools/migration/migration.types";
import { BOOKING_CONTRACT } from "../../../../tools/migration/booking.contract";
import { COURSE_CONTRACT } from "../../../../tools/migration/course.contract";
import { SCHEDULE_CONTRACT } from "../../../../tools/migration/schedule.contract";
import { USER_CONTRACT } from "../../../../tools/migration/user.contract";

function topLevelFields(contract: FieldContractEntry[], prefix: string): Set<string> {
  const out = new Set<string>(["_id"]);
  for (const entry of contract) {
    if (!entry.field.startsWith(`${prefix}.`)) continue;
    let rest = entry.field.slice(prefix.length + 1);
    if (rest.startsWith('"')) {
      out.add(rest.replace(/^"|"$/g, ""));
      continue;
    }
    rest = rest.split(/[.[]/)[0] ?? "";
    if (rest) out.add(rest);
  }
  return out;
}

export const DECLARED_USER_FIELDS: ReadonlySet<string> = new Set([
  ...topLevelFields(USER_CONTRACT, "users"),
  // Code-level alias handled by normalizeUserDateOfBirth.
  "dateofbirth",
  // Handled by the ETL as scoped JSONB (relational-model-plan.md: budget -> nullable JSONB).
  "budget",
]);

export const DECLARED_COURSE_FIELDS: ReadonlySet<string> = topLevelFields(COURSE_CONTRACT, "courses");
export const DECLARED_SCHEDULE_FIELDS: ReadonlySet<string> = topLevelFields(SCHEDULE_CONTRACT, "schedules");
export const DECLARED_BOOKING_FIELDS: ReadonlySet<string> = topLevelFields(BOOKING_CONTRACT, "bookingMock");

// Nested shapes (contract-documented element shapes).
export const DECLARED_TIME_SLOT_FIELDS: ReadonlySet<string> = new Set([
  "slot", "slotId", "totalSlot", "startTime", "endTime",
]);
export const DECLARED_MOCK_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "createdAt", "mock", "mockType", "mrValidation", "testSystem", "testType", "transactionId",
  "emailReminderSent", "mrValidationExpiry", "updatedAt",
]);
export const DECLARED_RESULT_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "segment", "feedback", "marks", "admin", "timestamp",
]);
export const DECLARED_ADMIN_SECTION_FIELDS: ReadonlySet<string> = new Set([
  "overallScore", "proficiencyLevel", "resultDate", "schemeCode", "adminComments", "adminSignature",
  "centreName", "testDate", "updatedAt",
]);
export const DECLARED_TEACHER_FIELDS: ReadonlySet<string> = new Set([
  "teacherL", "teacherLEmail", "teacherR", "teacherREmail", "teacherW", "teacherWEmail", "teacherS", "teacherSEmail",
]);
export const DECLARED_TRF_EMAIL_FIELDS: ReadonlySet<string> = new Set([
  "lastSentAt", "lastSubject", "lastFilename", "to", "history",
]);
export const DECLARED_TRF_HISTORY_FIELDS: ReadonlySet<string> = new Set(["at", "subject", "filename", "to"]);
