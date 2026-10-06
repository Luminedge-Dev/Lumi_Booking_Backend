// Stage 10.5 (D-031, closure patch) -- typed, machine-checkable mirror of
// the Course section of context/canonical-data-contract.md.

import type { FieldContractEntry } from "./migration.types";

export const COURSE_CONTRACT: FieldContractEntry[] = [
  {
    field: "courses._id",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "ObjectId",
    required: true,
    nullable: false,
    hasNormalizer: false,
    notes: "always ObjectId already -- 0 type inconsistencies, the cleanest collection.",
  },
  {
    field: "courses.name",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "string",
    required: true,
    nullable: false,
    hasNormalizer: false,
  },
  {
    field: "courses.image",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "string",
    required: true,
    nullable: false,
    hasNormalizer: false,
  },
  {
    field: "courses.homeBasedSystems",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "string[]",
    required: true,
    nullable: false,
    defaultValue: [],
    hasNormalizer: false,
    notes:
      "defaults to [] when absent -- the field is legitimately unsettable via scripts/unset-home-based-systems.js, so 'no array present' means 'no home-based systems configured', a data-shape default, not an invented business rule.",
  },
  {
    field: "courses.createdAt",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "Date",
    required: false,
    nullable: true,
    hasNormalizer: false,
    notes:
      "present in 80% of the 5 total documents; optional, no mixed-type issue observed -- course.normalizer.ts's normalizeCourseTimestamp is an extra presence/shape validator, not a required-by-classification type coercion.",
  },
  {
    field: "courses.updatedAt",
    classification: "PRESERVE",
    targetDisposition: "INCLUDE",
    canonicalType: "Date",
    required: false,
    nullable: true,
    hasNormalizer: false,
  },
];
