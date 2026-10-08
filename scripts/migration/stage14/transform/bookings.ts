// Stage 14 -- Booking (bookingMock) transform. Reuses normalizeBookingDocument
// (Stage 10.5), then validates references against what was ACTUALLY accepted
// for load, so the target never holds a booking whose user/schedule/slot is
// absent from the target.
//
// Location rules (relational-model-plan.md "Booking location predicates"):
//   - Home bookings are NEVER rejected for carrying schedule fields; those
//     values are preserved as-is and only counted as a finding.
//   - Test Center bookings need a resolvable schedule + slot. Dangling ones
//     are quarantined (legacy hard-delete of schedules allows orphans; the
//     reconciliation plan says ETL quarantines them).

import { normalizeBookingDocument } from "../../../../tools/migration/booking.normalizer";
import {
  canonicalHexId,
  containsNul,
  parseCalendarDate,
  sourceIdOf,
  type AggregateResult,
  type RawDoc,
} from "../common";
import type { PipelineState } from "../state";
import { DECLARED_BOOKING_FIELDS } from "./declared";

const STORED_TEXT_FIELDS = [
  "name", "attendance", "testSystem", "testTime", "startTime", "endTime", "teacherL", "teacherLEmail", "teacherR",
  "teacherREmail", "teacherW", "teacherWEmail", "teacherS", "teacherSEmail", "slotId",
] as const;

export function transformBooking(raw: RawDoc, state: PipelineState): AggregateResult {
  const sourceId = sourceIdOf(raw._id);
  const hexId = canonicalHexId(raw._id);
  if (hexId) state.sourceIds.bookingMock.add(hexId);
  state.noteUndeclared("bookingMock", raw, DECLARED_BOOKING_FIELDS);

  const reject = (p: { code: string; summary: string; field?: string; observedType?: string }): AggregateResult => ({
    entity: "bookingMock",
    sourceId,
    sourceUnits: {},
    rootQuarantine: {
      entity: "bookingMock",
      kind: "bookings",
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

  const normalized = normalizeBookingDocument(raw, sourceId);
  if (!normalized.ok) {
    const first = normalized.errors[0]!;
    return reject({
      code: first.code,
      summary: `normalizer rejected the booking document (${normalized.errors.length} error(s))`,
      field: first.field,
      observedType: first.observedType,
    });
  }
  const b = normalized.value;
  const id = b._id.toHexString();
  const userId = b.userId.toHexString();
  const scheduleId = b.scheduleId ? b.scheduleId.toHexString() : null;

  if (state.acceptedBookings.has(id)) {
    return reject({ code: "DUPLICATE_CANONICAL_ID", summary: "another booking document already resolved to this canonical id" });
  }

  const bookingDate = parseCalendarDate(b.bookingDate);
  if (!bookingDate) {
    return reject({ code: "INVALID_CALENDAR_DATE", summary: "bookingDate is not a real calendar date", field: "bookingMock.bookingDate", observedType: "string" });
  }

  if (STORED_TEXT_FIELDS.some((f) => containsNul((b as unknown as Record<string, unknown>)[f]))) {
    return reject({ code: "NUL_CHARACTER_UNSUPPORTED", summary: "a text value contains a NUL character PostgreSQL cannot store" });
  }

  // Required parent: user.
  if (!state.sourceIds.users.has(userId)) {
    return reject({ code: "USER_NOT_FOUND_IN_SOURCE", summary: "booking references a user id that does not exist in the source", field: "bookingMock.userId", observedType: "objectId" });
  }
  if (!state.acceptedUsers.has(userId) && !state.sampleMode) {
    return reject({ code: "PARENT_USER_QUARANTINED", summary: "booking references a user that was quarantined", field: "bookingMock.userId", observedType: "objectId" });
  }

  const findings: AggregateResult["findings"] = [];
  if (b.location === "Test Center") {
    if (scheduleId === null || b.slotId === undefined) {
      return reject({ code: "TEST_CENTER_MISSING_SCHEDULE_REF", summary: "Test Center booking lacks scheduleId and/or slotId", field: "bookingMock.scheduleId", observedType: "undefined" });
    }
    if (!state.sourceIds.schedules.has(scheduleId)) {
      return reject({ code: "SCHEDULE_NOT_FOUND_IN_SOURCE", summary: "Test Center booking references a schedule that no longer exists in the source", field: "bookingMock.scheduleId", observedType: "objectId" });
    }
    const slots = state.acceptedSchedules.get(scheduleId);
    if (!slots && !state.sampleMode) {
      return reject({ code: "PARENT_SCHEDULE_QUARANTINED", summary: "Test Center booking references a schedule that was quarantined", field: "bookingMock.scheduleId", observedType: "objectId" });
    }
    if (slots && !slots.has(b.slotId)) {
      return reject({ code: "SLOT_NOT_FOUND_IN_SCHEDULE", summary: "Test Center booking references a slotId absent from its schedule", field: "bookingMock.slotId", observedType: "string" });
    }
  } else if (scheduleId !== null || b.slotId !== undefined || b.startTime != null || b.endTime != null) {
    // Home booking carrying schedule fields: valid, preserved, reported.
    findings.push({ code: "HOME_BOOKING_WITH_SCHEDULE_FIELDS", scope: "bookingMock", count: 1 });
  }

  state.acceptedBookings.add(id);
  return {
    entity: "bookingMock",
    sourceId: id,
    sourceUnits: {},
    rows: {
      bookings: [
        {
          id,
          userId,
          scheduleId,
          slotId: b.slotId ?? null,
          name: b.name,
          location: b.location === "Test Center" ? "TestCenter" : "Home",
          bookingDate,
          status: b.status,
          attendance: b.attendance ?? null,
          testType: b.testType === "Computer-Based" ? "ComputerBased" : "PaperBased",
          testSystem: b.testSystem ?? null,
          testTime: b.testTime ?? null,
          startTime: b.startTime ?? null,
          endTime: b.endTime ?? null,
          teacherL: b.teacherL ?? null,
          teacherLEmail: b.teacherLEmail ?? null,
          teacherR: b.teacherR ?? null,
          teacherREmail: b.teacherREmail ?? null,
          teacherW: b.teacherW ?? null,
          teacherWEmail: b.teacherWEmail ?? null,
          teacherS: b.teacherS ?? null,
          teacherSEmail: b.teacherSEmail ?? null,
          trfEmailed: b.trfEmailed ?? null,
          trfEmailAt: b.trfEmailAt ?? null,
        },
      ],
    },
    childQuarantines: [],
    findings,
  };
}
