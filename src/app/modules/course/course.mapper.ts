import type { CourseDto, CourseRecord } from "./course.types";

// Identity passthrough: legacy returns full documents with no transformation.
export function toCourseDto(record: CourseRecord): CourseDto {
  return { ...record };
}
