// Stage 14 -- Course transform. Reuses normalizeCourseDocument (Stage 10.5).

import { normalizeCourseDocument } from "../../../../tools/migration/course.normalizer";
import {
  canonicalHexId,
  containsNul,
  sourceIdOf,
  type AggregateResult,
  type QuarantineEntry,
  type RawDoc,
} from "../common";
import type { PipelineState } from "../state";
import { DECLARED_COURSE_FIELDS } from "./declared";

export function transformCourse(raw: RawDoc, state: PipelineState): AggregateResult {
  const sourceId = sourceIdOf(raw._id);
  const hexId = canonicalHexId(raw._id);
  // Existence is recorded for EVERY source document, accepted or not.
  if (hexId) state.sourceIds.courses.add(hexId);
  state.noteUndeclared("courses", raw, DECLARED_COURSE_FIELDS);

  const reject = (code: string, summary: string, field?: string, observedType?: string): AggregateResult => ({
    entity: "courses",
    sourceId,
    sourceUnits: {},
    rootQuarantine: entry({ code, summary, field, observedType }),
    childQuarantines: [],
    findings: [],
  });
  const entry = (p: { code: string; summary: string; field?: string; observedType?: string }): QuarantineEntry => ({
    entity: "courses",
    kind: "courses",
    sourceId,
    scope: "root",
    code: p.code,
    field: p.field,
    observedType: p.observedType,
    summary: p.summary,
    units: 1,
  });

  const normalized = normalizeCourseDocument(raw, sourceId);
  if (!normalized.ok) {
    const first = normalized.errors[0]!;
    return reject(first.code, `normalizer rejected the course document (${normalized.errors.length} error(s))`, first.field, first.observedType);
  }
  const course = normalized.value;
  const id = course._id.toHexString();

  if (state.acceptedCourses.has(id)) {
    return reject("DUPLICATE_CANONICAL_ID", "another course document already resolved to this canonical id");
  }
  if ([course.name, course.image, ...course.homeBasedSystems].some(containsNul)) {
    return reject("NUL_CHARACTER_UNSUPPORTED", "a text value contains a NUL character PostgreSQL cannot store");
  }

  state.acceptedCourses.add(id);
  return {
    entity: "courses",
    sourceId: id,
    sourceUnits: {},
    rows: {
      courses: [
        {
          id,
          name: course.name,
          image: course.image,
          homeBasedSystems: course.homeBasedSystems,
          createdAt: course.createdAt ?? null,
          updatedAt: course.updatedAt ?? null,
        },
      ],
    },
    childQuarantines: [],
    findings: [],
  };
}
