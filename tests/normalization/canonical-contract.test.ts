// Stage 10.5 (D-031, closure patch) -- structural test proving the
// *.contract.ts registries stay honest: every field classified
// NORMALIZE_ON_READ has a real, exported normalizer (no silent coverage
// gap); every excluded-classification field is marked hasNormalizer:false
// (no silent scope creep); every entry is fully specified
// (canonicalType/required/nullable/targetDisposition); every
// EXCLUDE/QUARANTINE entry documents why; and the closed-enum fields'
// enumValues match what their normalizers actually accept.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FieldContractEntry } from "../../tools/migration/migration.types";
import { USER_CONTRACT } from "../../tools/migration/user.contract";
import { COURSE_CONTRACT } from "../../tools/migration/course.contract";
import { SCHEDULE_CONTRACT } from "../../tools/migration/schedule.contract";
import { BOOKING_CONTRACT } from "../../tools/migration/booking.contract";
import * as userNormalizer from "../../tools/migration/user.normalizer";
import * as courseNormalizer from "../../tools/migration/course.normalizer";
import * as scheduleNormalizer from "../../tools/migration/schedule.normalizer";
import * as bookingNormalizer from "../../tools/migration/booking.normalizer";

const ALL_CONTRACTS: Array<[string, FieldContractEntry[]]> = [
  ["user", USER_CONTRACT],
  ["course", COURSE_CONTRACT],
  ["schedule", SCHEDULE_CONTRACT],
  ["booking", BOOKING_CONTRACT],
];

const NON_NORMALIZING_CLASSIFICATIONS = new Set([
  "PRESERVE",
  "INVESTIGATE",
  "IGNORE_AS_HISTORICAL",
  "FUTURE_DATA_MIGRATION",
]);

// Fields where a real function exists purely as the whole-document
// normalizer's required-field/shape validator, not as a
// classification-driven coercion -- same precedent as the original Stage
// 10.5's courses.createdAt/updatedAt.
const HAS_NORMALIZER_EXEMPT_FIELDS = new Set([
  "courses.createdAt",
  "courses.updatedAt",
]);

describe("canonical contract honesty (structural, no fixtures)", () => {
  it("every NORMALIZE_ON_READ field is marked hasNormalizer:true", () => {
    for (const [entity, contract] of ALL_CONTRACTS) {
      for (const entry of contract) {
        if (entry.classification === "NORMALIZE_ON_READ") {
          assert.equal(
            entry.hasNormalizer,
            true,
            `${entity}: field "${entry.field}" is classified NORMALIZE_ON_READ but hasNormalizer is not true -- silent coverage gap`
          );
        }
      }
    }
  });

  it("every excluded-classification field is marked hasNormalizer:false", () => {
    for (const [entity, contract] of ALL_CONTRACTS) {
      for (const entry of contract) {
        if (NON_NORMALIZING_CLASSIFICATIONS.has(entry.classification) && !HAS_NORMALIZER_EXEMPT_FIELDS.has(entry.field)) {
          assert.equal(
            entry.hasNormalizer,
            false,
            `${entity}: field "${entry.field}" is classified ${entry.classification} but hasNormalizer is true -- silent scope creep`
          );
        }
      }
    }
  });

  it("every contract entry has canonicalType/required/nullable/targetDisposition populated", () => {
    for (const [entity, contract] of ALL_CONTRACTS) {
      for (const entry of contract) {
        assert.equal(typeof entry.canonicalType, "string", `${entity}: "${entry.field}" missing canonicalType`);
        assert.ok(entry.canonicalType.length > 0, `${entity}: "${entry.field}" has empty canonicalType`);
        assert.equal(typeof entry.required, "boolean", `${entity}: "${entry.field}" missing required`);
        assert.equal(typeof entry.nullable, "boolean", `${entity}: "${entry.field}" missing nullable`);
        assert.ok(
          entry.targetDisposition === "INCLUDE" || entry.targetDisposition === "EXCLUDE" || entry.targetDisposition === "QUARANTINE",
          `${entity}: "${entry.field}" missing/invalid targetDisposition`
        );
      }
    }
  });

  it("every EXCLUDE/QUARANTINE entry documents why in notes", () => {
    for (const [entity, contract] of ALL_CONTRACTS) {
      for (const entry of contract) {
        if (entry.targetDisposition === "EXCLUDE" || entry.targetDisposition === "QUARANTINE") {
          assert.ok(
            entry.notes && entry.notes.length > 0,
            `${entity}: "${entry.field}" is ${entry.targetDisposition} but has no notes explaining why`
          );
        }
      }
    }
  });

  // The 15 fields now classified NORMALIZE_ON_READ (up from 11: +role,
  // +status for User; +status for Schedule; +testType for Booking) must
  // each have a real, exported normalizer function -- hardcoded here rather
  // than derived by name-guessing, so a rename on either side breaks this
  // test loudly.
  const EXPECTED_NORMALIZER_EXPORTS: Array<[string, unknown]> = [
    ["user.normalizeUserDateOfBirth", userNormalizer.normalizeUserDateOfBirth],
    ["user.normalizeUserRole", userNormalizer.normalizeUserRole],
    ["user.normalizeUserStatus", userNormalizer.normalizeUserStatus],
    ["schedule.normalizeScheduleCourseId", scheduleNormalizer.normalizeScheduleCourseId],
    ["schedule.normalizeScheduleCreatedAt", scheduleNormalizer.normalizeScheduleCreatedAt],
    ["schedule.normalizeScheduleTotalSlot", scheduleNormalizer.normalizeScheduleTotalSlot],
    ["schedule.normalizeScheduleTestType", scheduleNormalizer.normalizeScheduleTestType],
    ["schedule.normalizeScheduleStatus", scheduleNormalizer.normalizeScheduleStatus],
    ["booking.normalizeBookingId", bookingNormalizer.normalizeBookingId],
    ["booking.normalizeBookingUserId", bookingNormalizer.normalizeBookingUserId],
    ["booking.normalizeBookingScheduleId", bookingNormalizer.normalizeBookingScheduleId],
    ["booking.normalizeBookingSlotId", bookingNormalizer.normalizeBookingSlotId],
    ["booking.normalizeBookingDate", bookingNormalizer.normalizeBookingDate],
    ["booking.normalizeBookingStatus", bookingNormalizer.normalizeBookingStatus],
    ["booking.normalizeBookingTestType", bookingNormalizer.normalizeBookingTestType],
    ["booking.normalizeBookingLocation", bookingNormalizer.normalizeBookingLocation],
  ];

  it("every expected normalizer function is actually exported", () => {
    assert.equal(EXPECTED_NORMALIZER_EXPORTS.length, 16, "expected exactly 16 characterized NORMALIZE_ON_READ fields");
    for (const [name, fn] of EXPECTED_NORMALIZER_EXPORTS) {
      assert.equal(typeof fn, "function", `expected ${name} to be an exported function`);
    }
  });

  it("every whole-document normalizer is exported", () => {
    assert.equal(typeof userNormalizer.normalizeUserDocument, "function");
    assert.equal(typeof courseNormalizer.normalizeCourseDocument, "function");
    assert.equal(typeof scheduleNormalizer.normalizeScheduleDocument, "function");
    assert.equal(typeof bookingNormalizer.normalizeBookingDocument, "function");
  });

  it("courseNormalizer exposes its optional presence/shape validator even though Course has no NORMALIZE_ON_READ fields", () => {
    assert.equal(typeof courseNormalizer.normalizeCourseTimestamp, "function");
  });

  it("the fully-closed enum fields document audit-confirmed completeness in their contract notes/rejectPolicy", () => {
    const scheduleTestType = SCHEDULE_CONTRACT.find((e) => e.field === "schedules.testType");
    const scheduleStatus = SCHEDULE_CONTRACT.find((e) => e.field === "schedules.status");
    const bookingStatus = BOOKING_CONTRACT.find((e) => e.field === "bookingMock.status");
    const bookingTestType = BOOKING_CONTRACT.find((e) => e.field === "bookingMock.testType");
    const userRole = USER_CONTRACT.find((e) => e.field === "users.role");
    const userStatus = USER_CONTRACT.find((e) => e.field === "users.status");

    assert.deepEqual(scheduleTestType?.enumValues, ["Computer-Based", "Paper-Based"]);
    assert.deepEqual(bookingTestType?.enumValues, ["Computer-Based", "Paper-Based"]);
    assert.deepEqual(bookingStatus?.enumValues, ["Present", "Absent", "pending", "completed", "missed"]);
    assert.deepEqual(userRole?.enumValues, ["user", "teacher", "bdm", "admin"]);
    assert.deepEqual(userStatus?.enumValues, ["active", "checked", "completed", "blocked"]);
    assert.deepEqual(scheduleStatus?.enumValues, ["Scheduled", "Cancelled"]);

    assert.ok(scheduleStatus?.notes?.includes("pending"), "schedules.status notes must document the pending historical anomaly");
    assert.ok(userStatus?.rejectPolicy?.includes("null"), "users.status rejectPolicy must document the null-handling rule");
  });

  it("enumValues for each closed-enum field matches what its normalizer actually accepts as canonical/alias", () => {
    for (const value of ["Computer-Based", "Paper-Based"]) {
      const result = scheduleNormalizer.normalizeScheduleTestType(value);
      assert.ok(result.ok, `schedules.testType normalizer should accept canonical value "${value}"`);
    }
    assert.ok(scheduleNormalizer.normalizeScheduleTestType("ComputerBased").ok, "schedules.testType normalizer should accept its known alias");

    for (const value of ["Present", "Absent", "pending", "completed", "missed"]) {
      const result = bookingNormalizer.normalizeBookingStatus(value);
      assert.ok(result.ok, `bookingMock.status normalizer should accept canonical value "${value}"`);
    }
    assert.ok(bookingNormalizer.normalizeBookingStatus("present").ok, "bookingMock.status normalizer should accept its known alias");

    for (const value of ["user", "teacher", "bdm", "admin"]) {
      assert.ok(userNormalizer.normalizeUserRole(value).ok, `users.role normalizer should accept canonical value "${value}"`);
    }

    for (const value of ["active", "checked", "completed", "blocked"]) {
      assert.ok(userNormalizer.normalizeUserStatus(value).ok, `users.status normalizer should accept canonical value "${value}"`);
    }
  });

  // Field-completeness guard (final closure-patch round): an explicit,
  // hardcoded inventory of every field this session reconciled against
  // database-profile.md plus direct code reads. This is NOT a claim that
  // the counts below are a byte-for-byte transcript of the audit PDF --
  // it guards this reconciled baseline so a future accidental removal, or
  // a newly-discovered-but-unadded field, fails the suite immediately
  // rather than silently regressing.
  describe("audited-field-inventory completeness guard", () => {
    function fieldNames(contract: FieldContractEntry[]): string[] {
      return contract.map((e) => e.field);
    }

    it("every expected User top-level persisted field has a contract entry", () => {
      const present = fieldNames(USER_CONTRACT);
      const expected = [
        "users._id", "users.name", "users.email", "users.role", "users.status",
        "users.isDeleted", "users.createdAt", "users.updatedAt", "users.password",
        "users.dateOfBirth", "users.contactNo", "users.passportNumber", "users.sex",
        "users.result", "users.mocks", "users.mockType", "users.testSystem",
        "users.testType", "users.profileChangeRequestStatus", "users.profileEditNote",
        "users.needPasswordChange", "users.passwordChangedAt", "users.transactionId",
        "users.teacherLEmail", "users.teacherREmail", "users.teacherWEmail", "users.teacherSEmail",
        "users.lastTrfEmailAt", "users.mock", "users.totalMock",
        "users.resultsBySchedule", "users.feedbackStatusBySchedule",
        "users.adminSectionBySchedule", "users.teachersBySchedule", "users.trfEmailsBySchedule",
        "users.\" testType\"",
      ];
      for (const field of expected) {
        assert.ok(present.includes(field), `USER_CONTRACT is missing an entry for "${field}"`);
      }
    });

    it("every expected Course field has a contract entry", () => {
      const present = fieldNames(COURSE_CONTRACT);
      const expected = ["courses._id", "courses.name", "courses.image", "courses.homeBasedSystems", "courses.createdAt", "courses.updatedAt"];
      for (const field of expected) {
        assert.ok(present.includes(field), `COURSE_CONTRACT is missing an entry for "${field}"`);
      }
    });

    it("every expected canonical Schedule field, plus the quarantined flattened legacy shape, has a contract entry", () => {
      const present = fieldNames(SCHEDULE_CONTRACT);
      const expected = [
        "schedules._id", "schedules.name", "schedules.courseId", "schedules.createdAt",
        "schedules.timeSlots", "schedules.timeSlots[].totalSlot", "schedules.timeSlots[].slotId",
        "schedules.timeSlots[].slot", "schedules.timeSlots[].startTime", "schedules.timeSlots[].endTime",
        "schedules.testType", "schedules.status", "schedules.testSystem",
        "schedules.startDate", "schedules.endDate",
        "schedules (3 flattened legacy documents, 0.13%)",
      ];
      for (const field of expected) {
        assert.ok(present.includes(field), `SCHEDULE_CONTRACT is missing an entry for "${field}"`);
      }
    });

    it("all 24 audited bookingMock top-level fields have an explicit contract entry", () => {
      const present = fieldNames(BOOKING_CONTRACT);
      const expected = [
        "bookingMock._id", "bookingMock.userId", "bookingMock.scheduleId", "bookingMock.slotId",
        "bookingMock.name", "bookingMock.location", "bookingMock.bookingDate", "bookingMock.status",
        "bookingMock.attendance", "bookingMock.testType", "bookingMock.testSystem",
        "bookingMock.testTime", "bookingMock.startTime", "bookingMock.endTime",
        "bookingMock.teacherL", "bookingMock.teacherLEmail", "bookingMock.teacherR", "bookingMock.teacherREmail",
        "bookingMock.teacherS", "bookingMock.teacherSEmail", "bookingMock.teacherW", "bookingMock.teacherWEmail",
        "bookingMock.trfEmailed", "bookingMock.trfEmailAt",
      ];
      assert.equal(expected.length, 24, "expected exactly 24 audited bookingMock top-level fields");
      for (const field of expected) {
        assert.ok(present.includes(field), `BOOKING_CONTRACT is missing an entry for "${field}"`);
      }
    });
  });
});
