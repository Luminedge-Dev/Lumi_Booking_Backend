// Stage 14 -- Schedule transform. Reuses normalizeScheduleDocument (Stage 10.5),
// then applies the relational-only checks the normalizer does not own.
//
// timeSlots[] -> schedule_slots (position = array index; slot -> seats_left,
// totalSlot -> capacity_total, per canonical-data-contract.md / database-
// canonical-models.md). slot_counters is seeded from the MAX numeric slotId of
// the schedule (next_n = max + 1), per mongo-to-postgres-plan.md; if that is
// not derivable the COUNTER row alone is quarantined -- nothing is invented.

import { normalizeScheduleDocument } from "../../../../tools/migration/schedule.normalizer";
import {
  canonicalHexId,
  containsNul,
  deterministicUuid,
  parseCalendarDate,
  readIntValue,
  sourceIdOf,
  isRecord,
  type AggregateResult,
  type QuarantineEntry,
  type RawDoc,
  type Row,
} from "../common";
import type { PipelineState } from "../state";
import { DECLARED_SCHEDULE_FIELDS, DECLARED_TIME_SLOT_FIELDS } from "./declared";

const INT32_MAX = 2147483647;

function rawSlotCount(raw: RawDoc): number {
  return Array.isArray(raw.timeSlots) ? raw.timeSlots.length : 0;
}

export function transformSchedule(raw: RawDoc, state: PipelineState): AggregateResult {
  const sourceId = sourceIdOf(raw._id);
  const hexId = canonicalHexId(raw._id);
  if (hexId) state.sourceIds.schedules.add(hexId);
  state.noteUndeclared("schedules", raw, DECLARED_SCHEDULE_FIELDS);
  if (Array.isArray(raw.timeSlots)) {
    for (const slot of raw.timeSlots) {
      if (isRecord(slot)) state.noteUndeclared("schedules.timeSlots[]", slot, DECLARED_TIME_SLOT_FIELDS);
    }
  }

  // Independent source-unit counts, taken from the RAW document.
  const sourceUnits = { schedule_slots: rawSlotCount(raw), slot_counters: 1 } as const;

  const rejectRoot = (p: { code: string; summary: string; field?: string; observedType?: string }): AggregateResult => ({
    entity: "schedules",
    sourceId,
    sourceUnits: { ...sourceUnits },
    rootQuarantine: {
      entity: "schedules",
      kind: "schedules",
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

  const normalized = normalizeScheduleDocument(raw, sourceId);
  if (!normalized.ok) {
    const first = normalized.errors[0]!;
    return rejectRoot({
      code: first.code,
      summary: `normalizer rejected the schedule document (${normalized.errors.length} error(s))`,
      field: first.field,
      observedType: first.observedType,
    });
  }
  const schedule = normalized.value;
  const id = schedule._id.toHexString();
  const courseId = schedule.courseId.toHexString();

  if (state.acceptedSchedules.has(id)) {
    return rejectRoot({ code: "DUPLICATE_CANONICAL_ID", summary: "another schedule document already resolved to this canonical id" });
  }

  const startDate = parseCalendarDate(schedule.startDate);
  if (!startDate) return rejectRoot({ code: "INVALID_CALENDAR_DATE", summary: "startDate is not a real YYYY-MM-DD calendar date", field: "schedules.startDate", observedType: "string" });
  const endDate = parseCalendarDate(schedule.endDate);
  if (!endDate) return rejectRoot({ code: "INVALID_CALENDAR_DATE", summary: "endDate is not a real YYYY-MM-DD calendar date", field: "schedules.endDate", observedType: "string" });

  if (!state.sourceIds.courses.has(courseId)) {
    return rejectRoot({ code: "COURSE_NOT_FOUND_IN_SOURCE", summary: "schedule references a course id that does not exist in the source", field: "schedules.courseId", observedType: "objectId" });
  }
  if (!state.acceptedCourses.has(courseId)) {
    return rejectRoot({ code: "PARENT_COURSE_QUARANTINED", summary: "schedule references a course that was quarantined", field: "schedules.courseId", observedType: "objectId" });
  }

  const textValues = [schedule.name, schedule.testSystem, ...schedule.timeSlots.flatMap((s) => [s.slotId, s.startTime, s.endTime])];
  if (textValues.some(containsNul)) {
    return rejectRoot({ code: "NUL_CHARACTER_UNSUPPORTED", summary: "a text value contains a NUL character PostgreSQL cannot store" });
  }

  // Slot-level relational validation. Any failure withholds the whole schedule:
  // a schedule with a partial slot set would silently mis-model capacity.
  const seen = new Set<string>();
  const slotRows: Row[] = [];
  for (let position = 0; position < schedule.timeSlots.length; position += 1) {
    const slot = schedule.timeSlots[position]!;
    if (seen.has(slot.slotId)) {
      return rejectRoot({ code: "DUPLICATE_SLOT_ID", summary: `slotId repeats inside one schedule (timeSlots[${position}])`, field: "schedules.timeSlots[].slotId", observedType: "string" });
    }
    seen.add(slot.slotId);
    const seats = readIntValue(slot.slot, `schedules.timeSlots[${position}].slot`);
    if (!seats.ok) return rejectRoot({ code: seats.code, summary: `seat counter is not a storable integer (timeSlots[${position}])`, field: "schedules.timeSlots[].slot", observedType: seats.observedType });
    const capacity = readIntValue(slot.totalSlot, `schedules.timeSlots[${position}].totalSlot`);
    if (!capacity.ok) return rejectRoot({ code: capacity.code, summary: `capacity is not a storable integer (timeSlots[${position}])`, field: "schedules.timeSlots[].totalSlot", observedType: capacity.observedType });
    slotRows.push({
      id: deterministicUuid(`schedule_slot:${id}:${slot.slotId}`),
      scheduleId: id,
      position,
      slotId: slot.slotId,
      seatsLeft: seats.value,
      capacityTotal: capacity.value,
      startTime: slot.startTime,
      endTime: slot.endTime,
    });
  }

  const childQuarantines: QuarantineEntry[] = [];
  const counterRow = deriveCounter(id, schedule.timeSlots.map((s) => s.slotId));
  const rows: AggregateResult["rows"] = {
    schedules: [
      {
        id,
        name: schedule.name,
        courseId,
        startDate,
        endDate,
        testType: schedule.testType === "Computer-Based" ? "ComputerBased" : "PaperBased",
        testSystem: schedule.testSystem ?? null,
        status: schedule.status,
        createdAt: schedule.createdAt,
      },
    ],
    schedule_slots: slotRows,
  };
  if ("row" in counterRow) {
    rows.slot_counters = [counterRow.row];
  } else {
    childQuarantines.push({
      entity: "schedules",
      kind: "slot_counters",
      sourceId: id,
      scope: "slot_counters",
      code: counterRow.code,
      summary: counterRow.summary,
      units: 1,
    });
  }

  state.acceptedSchedules.set(id, seen);
  return { entity: "schedules", sourceId: id, sourceUnits: { ...sourceUnits }, rows, childQuarantines, findings: [] };
}

function deriveCounter(scheduleId: string, slotIds: string[]): { row: Row } | { code: string; summary: string } {
  if (slotIds.length === 0) {
    return { code: "NO_SLOTS_TO_SEED_COUNTER", summary: "schedule has no timeSlots, so a counter seed cannot be derived from the persisted slotIds" };
  }
  let max = 0;
  for (const slotId of slotIds) {
    if (!/^\d+$/.test(slotId)) {
      return { code: "NON_NUMERIC_SLOT_ID", summary: "a slotId is not a non-negative integer string, so the counter seed is not derivable" };
    }
    const n = Number(slotId);
    if (!Number.isSafeInteger(n) || n >= INT32_MAX) {
      return { code: "SLOT_ID_OUT_OF_RANGE", summary: "a slotId exceeds the storable counter range" };
    }
    if (n > max) max = n;
  }
  return { row: { scheduleId, nextN: max + 1 } };
}