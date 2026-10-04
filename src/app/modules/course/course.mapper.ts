import type { CourseDto, CourseRecord } from "./course.types";

// Identity passthrough by design -- legacy has no projection/transformation
// at all for /courses, so neither does this mapper. Exists as a named seam
// (not dead code): a stable place for the controller to call, and for a
// future stage to add real transformation without touching the repository
// or controller.
export function toCourseDto(record: CourseRecord): CourseDto {
  return { ...record };
}
