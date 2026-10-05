import type { ScheduleRecord } from "./schedule.types";

// Open/passthrough shaping only, no business logic. Legacy's admin listing
// and daily read both return full documents with zero projection, and
// Stage 6 found 3 rare flattened Schedule documents that must not vanish or
// get coerced into a narrow shape. No dateOfBirth-style aliasing exists on
// Schedule -- this mapper's only real job is "don't drop fields," not
// "rename fields."
export function toScheduleDto(record: ScheduleRecord): ScheduleRecord {
  return { ...record };
}

export function toScheduleDtoList(records: ScheduleRecord[]): ScheduleRecord[] {
  return records.map(toScheduleDto);
}
