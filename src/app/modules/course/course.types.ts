// Open shape: the legacy contract returned the stored document untouched.
// Persistence (PostgreSQL, Stage 15) supplies the Stage 13 columns under the
// legacy field names; absent/null optional columns are omitted, never emitted
// as null.
export interface CourseRecord extends Record<string, unknown> {
  _id: string;
  name: string;
  image: string;
  homeBasedSystems: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type CourseDto = CourseRecord;
