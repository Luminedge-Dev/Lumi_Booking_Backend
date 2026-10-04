// Legacy GET /courses does coursesCollection.find({}).toArray() with ZERO
// projection -- full raw documents, no narrowing. These types therefore type
// the 6 fields Stage 6's canonical-model audit confirmed (database-canonical-
// models.md) WITHOUT excluding anything else a document might carry -- the
// index signature keeps the shape genuinely open, matching the real legacy
// contract (see Stage 8 plan ss4/ss6: "must not drop a 7th field").
export interface CourseRecord extends Record<string, unknown> {
  _id: unknown;
  name?: unknown;
  image?: unknown;
  homeBasedSystems?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CourseDto = CourseRecord;
