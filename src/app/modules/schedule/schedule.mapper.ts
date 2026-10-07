import type { ScheduleRecord } from "./schedule.types";

// Passthrough: preserve all document fields, including rare flattened shapes.
export function toScheduleDto(record: ScheduleRecord): ScheduleRecord {
  return { ...record };
}

export function toScheduleDtoList(records: ScheduleRecord[]): ScheduleRecord[] {
  return records.map(toScheduleDto);
}
