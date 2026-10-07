// Open shape: preserves unknown fields instead of dropping them.
export interface CourseRecord extends Record<string, unknown> {
  _id: unknown;
  name?: unknown;
  image?: unknown;
  homeBasedSystems?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CourseDto = CourseRecord;
