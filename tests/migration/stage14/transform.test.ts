// Stage 14 -- transform mapping, null vs absent, dates, enums, deterministic child
// identity and quarantine reasons. Hand-built fixtures only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { PipelineState } from "../../../scripts/migration/stage14/state";
import { transformBooking } from "../../../scripts/migration/stage14/transform/bookings";
import { transformCourse } from "../../../scripts/migration/stage14/transform/courses";
import { transformSchedule } from "../../../scripts/migration/stage14/transform/schedules";
import { transformUser } from "../../../scripts/migration/stage14/transform/users";
import { deterministicUuid, parseCalendarDate, readIntValue, toJsonValue, type AggregateResult } from "../../../scripts/migration/stage14/common";
import { TABLE_SPECS, unknownColumns } from "../../../scripts/migration/stage14/columns";
import { buildWorld, userDoc, type World } from "./helpers/fixtures";

/** A state primed the way the pipeline's pre-pass primes it. */
function primedState(world: World): PipelineState {
  const state = new PipelineState();
  state.sourceIds.users.add(world.ids.userA.toHexString());
  state.sourceIds.users.add(world.ids.userB.toHexString());
  state.sourceIds.courses.add(world.ids.course.toHexString());
  state.sourceIds.schedules.add(world.ids.schedule.toHexString());
  state.sourceIds.bookingMock.add(world.ids.tcBooking.toHexString());
  state.sourceIds.bookingMock.add(world.ids.homeBooking.toHexString());
  state.keyIndex = { bookings: state.sourceIds.bookingMock, schedules: state.sourceIds.schedules };
  return state;
}

function loadParents(world: World, state: PipelineState): void {
  assert.ok(transformCourse(world.course, state).rows?.courses);
  assert.ok(transformSchedule(world.schedule, state).rows?.schedules);
  assert.ok(transformUser(world.userA, state).rows?.users);
  assert.ok(transformUser(world.userB, state).rows?.users);
}

function codes(result: AggregateResult): string[] {
  return [result.rootQuarantine?.code, ...result.childQuarantines.map((c) => c.code)].filter((c): c is string => c !== undefined);
}

describe("Stage 14 transform: relational mapping", () => {
  it("maps a schedule to one schedule row, one slot row per timeSlots[] entry (slotId scoped per schedule) and one counter", () => {
    const world = buildWorld();
    const state = primedState(world);
    transformCourse(world.course, state);
    const result = transformSchedule(world.schedule, state);
    assert.equal(result.rootQuarantine, undefined);
    const scheduleId = world.ids.schedule.toHexString();
    assert.equal(result.rows!.schedules!.length, 1);
    assert.equal(result.rows!.schedule_slots!.length, 2);
    assert.equal(result.rows!.slot_counters!.length, 1);
    assert.deepEqual(result.rows!.schedule_slots!.map((s) => [s.scheduleId, s.slotId, s.position]), [[scheduleId, "1", 0], [scheduleId, "2", 1]]);
    assert.equal(result.sourceUnits.schedule_slots, 2);
  });

  it("maps calendar dates to DATE (midnight UTC), enums to Prisma names, and preserves the source ObjectId as a string id", () => {
    const world = buildWorld();
    const state = primedState(world);
    transformCourse(world.course, state);
    const row = transformSchedule(world.schedule, state).rows!.schedules![0]!;
    assert.equal(row.id, world.ids.schedule.toHexString());
    assert.equal(row.courseId, world.ids.course.toHexString());
    assert.equal((row.startDate as Date).toISOString(), "2024-02-01T00:00:00.000Z");
    assert.equal(row.testType, "ComputerBased");
    assert.equal(row.status, "Scheduled");
  });

  it("maps mocks[] to one mock_allocations row each and keeps HH:MM times as text", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const user = transformUser(userDoc(new ObjectId("6500000000000000000000b9"), world.userA), primedState(world));
    assert.equal(user.rows!.mock_allocations!.length, 2);
    assert.equal(user.sourceUnits.mock_allocations, 2);
    const booking = transformBooking(world.testCenterBooking, state);
    assert.equal(booking.rows!.bookings![0]!.startTime, "09:00");
    assert.equal(booking.rows!.bookings![0]!.location, "TestCenter");
    assert.equal(booking.rows!.bookings![0]!.testType, "ComputerBased");
  });

  it("resolves each *BySchedule key deterministically to a booking XOR a schedule", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, new PipelineState());
    const result = transformUser(world.userA, state);
    const teachers = result.rows!.teacher_assignments!;
    assert.equal(teachers.length, 2);
    const forSchedule = teachers.find((t) => t.scheduleId === world.ids.schedule.toHexString())!;
    const forBooking = teachers.find((t) => t.bookingId === world.ids.homeBooking.toHexString())!;
    assert.equal(forSchedule.bookingId, null);
    assert.equal(forBooking.scheduleId, null);
    assert.equal(result.rows!.feedback_entries!.length, 1);
    assert.equal(result.rows!.feedback_status!.length, 2);
    assert.equal(result.rows!.admin_sections!.length, 1);
    assert.equal(result.rows!.trf_emails!.length, 1);
    assert.equal(result.rows!.trf_email_history!.length, 2);
  });

  it("preserves feedback/marks verbatim as scoped JSONB and reports the observed polymorphic type", () => {
    const world = buildWorld();
    const result = transformUser(world.userA, primedState(world));
    const entry = result.rows!.feedback_entries![0]!;
    assert.equal(entry.feedback, "good");
    assert.deepEqual(entry.marks, { raw: 30 });
    const codesSeen = result.findings.map((f) => f.code);
    assert.ok(codesSeen.includes("FEEDBACK_VALUE_TYPE_string"));
    assert.ok(codesSeen.includes("MARKS_VALUE_TYPE_object"));
  });

  it("does not create Better Auth rows (Session/Account/Verification)", () => {
    const world = buildWorld();
    const result = transformUser(world.userA, primedState(world));
    for (const table of ["sessions", "accounts", "verifications"] as const) {
      assert.equal((result.rows as Record<string, unknown>)[table], undefined);
    }
  });

  it("every produced row only uses columns the Stage 13 table spec declares", () => {
    const world = buildWorld();
    const state = primedState(world);
    for (const result of [
      transformCourse(world.course, state),
      transformSchedule(world.schedule, state),
      transformUser(world.userA, state),
      transformUser(world.userB, state),
      transformBooking(world.testCenterBooking, state),
      transformBooking(world.homeBooking, state),
    ]) {
      for (const [table, rows] of Object.entries(result.rows ?? {})) {
        for (const row of rows ?? []) {
          assert.deepEqual(unknownColumns(table as keyof typeof TABLE_SPECS, row), [], `${table} has columns outside the table spec`);
        }
      }
    }
  });
});

describe("Stage 14 transform: null vs absent", () => {
  it("keeps an explicit null as null and an absent optional field as null in SQL terms, never an invented default", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const withNull = transformBooking({ ...world.testCenterBooking, _id: new ObjectId(), testSystem: null }, state);
    const absent = (() => {
      const raw = { ...world.testCenterBooking, _id: new ObjectId() } as Record<string, unknown>;
      delete raw.testSystem;
      return transformBooking(raw, state);
    })();
    assert.equal(withNull.rows!.bookings![0]!.testSystem, null);
    assert.equal(absent.rows!.bookings![0]!.testSystem, null);
  });

  it("never defaults a missing required field (location) - it is quarantined with its own reason", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const raw = { ...world.homeBooking, _id: new ObjectId() } as Record<string, unknown>;
    delete raw.location;
    const result = transformBooking(raw, state);
    assert.equal(result.rows, undefined);
    assert.equal(result.rootQuarantine?.code, "MISSING_REQUIRED_FIELD");
    assert.equal(result.rootQuarantine?.field, "bookingMock.location");
  });
});

describe("Stage 14 transform: booking rules", () => {
  it("does NOT reject a Home booking merely because it carries schedule fields (it is preserved and reported)", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const result = transformBooking({ ...world.homeBooking, _id: new ObjectId(), scheduleId: world.ids.schedule, slotId: "1", startTime: "09:00" }, state);
    assert.equal(result.rootQuarantine, undefined);
    assert.equal(result.rows!.bookings![0]!.scheduleId, world.ids.schedule.toHexString());
    assert.ok(result.findings.some((f) => f.code === "HOME_BOOKING_WITH_SCHEDULE_FIELDS"));
  });

  it("quarantines a Test Center booking whose slot is absent from its schedule, with a distinct reason", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const result = transformBooking({ ...world.testCenterBooking, _id: new ObjectId(), slotId: "99" }, state);
    assert.equal(result.rootQuarantine?.code, "SLOT_NOT_FOUND_IN_SCHEDULE");
  });

  it("quarantines a booking whose user or schedule does not exist in the source", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    const missingUser = transformBooking({ ...world.testCenterBooking, _id: new ObjectId(), userId: new ObjectId() }, state);
    assert.equal(missingUser.rootQuarantine?.code, "USER_NOT_FOUND_IN_SOURCE");
    const missingSchedule = transformBooking({ ...world.testCenterBooking, _id: new ObjectId(), scheduleId: new ObjectId() }, state);
    assert.equal(missingSchedule.rootQuarantine?.code, "SCHEDULE_NOT_FOUND_IN_SOURCE");
  });

  it("quarantines a booking whose parent user was itself quarantined (PARENT_USER_QUARANTINED)", () => {
    const world = buildWorld();
    const state = primedState(world);
    transformCourse(world.course, state);
    transformSchedule(world.schedule, state);
    // userA exists in the source but was never accepted (e.g. its normalizer rejected it).
    const result = transformBooking(world.testCenterBooking, state);
    assert.equal(result.rootQuarantine?.code, "PARENT_USER_QUARANTINED");
  });

  it("quarantines a duplicate canonical booking id", () => {
    const world = buildWorld();
    const state = primedState(world);
    loadParents(world, state);
    assert.equal(transformBooking(world.testCenterBooking, state).rootQuarantine, undefined);
    assert.equal(transformBooking(world.testCenterBooking, state).rootQuarantine?.code, "DUPLICATE_CANONICAL_ID");
  });
});

describe("Stage 14 transform: quarantine reasons and no silent drops", () => {
  it("quarantines an unresolvable *BySchedule key with a reason and counts its units", () => {
    const world = buildWorld();
    const state = primedState(world);
    const unknownKey = new ObjectId().toHexString();
    const result = transformUser(
      userDoc(world.ids.userA, { teachersBySchedule: { [unknownKey]: { teacherL: "x" }, [world.ids.schedule.toHexString()]: { teacherL: "y" } } }),
      state
    );
    assert.equal(result.rows!.teacher_assignments!.length, 1);
    assert.deepEqual(codes(result), ["UNRESOLVED_SCHEDULE_KEY"]);
    assert.equal(result.sourceUnits.teacher_assignments, 2);
    assert.ok(result.findings.some((f) => f.code === "KEY_UNRESOLVED"));
  });

  it("quarantines a key that matches BOTH a booking and a schedule id as ambiguous (never guesses)", () => {
    const world = buildWorld();
    const state = primedState(world);
    state.sourceIds.bookingMock.add(world.ids.schedule.toHexString());
    const result = transformUser(userDoc(world.ids.userA, { teachersBySchedule: { [world.ids.schedule.toHexString()]: { teacherL: "x" } } }), state);
    assert.equal(result.rows!.teacher_assignments, undefined);
    assert.deepEqual(codes(result), ["AMBIGUOUS_SCHEDULE_KEY"]);
  });

  it("withholds the whole schedule (reason attached) when a slotId repeats inside it", () => {
    const world = buildWorld();
    const state = primedState(world);
    transformCourse(world.course, state);
    const dup = { ...world.schedule, timeSlots: [...(world.schedule.timeSlots as unknown[]), { slot: 1, slotId: "1", totalSlot: 2, startTime: "15:00", endTime: "16:00" }] };
    const result = transformSchedule(dup, state);
    assert.equal(result.rootQuarantine?.code, "DUPLICATE_SLOT_ID");
    assert.equal(result.rows, undefined);
    assert.equal(result.sourceUnits.schedule_slots, 3);
  });

  it("quarantines a schedule with a malformed courseId and one that references a missing course", () => {
    const world = buildWorld();
    const state = primedState(world);
    transformCourse(world.course, state);
    assert.equal(transformSchedule({ ...world.schedule, courseId: "not-an-object-id" }, state).rootQuarantine?.code, "INVALID_OBJECT_ID_SHAPE");
    assert.equal(transformSchedule({ ...world.schedule, _id: new ObjectId(), courseId: new ObjectId() }, state).rootQuarantine?.code, "COURSE_NOT_FOUND_IN_SOURCE");
  });

  it("quarantines a user whose normalizer rejects it (null status) instead of repairing it", () => {
    const world = buildWorld();
    const state = primedState(world);
    const result = transformUser(userDoc(world.ids.userA, { status: null }), state);
    assert.equal(result.rows, undefined);
    assert.equal(result.rootQuarantine?.code, "NULL_STATUS_VALUE");
  });

  it("quarantines a NUL character instead of letting PostgreSQL reject the batch", () => {
    const world = buildWorld();
    const state = primedState(world);
    const result = transformUser(userDoc(world.ids.userA, { name: "bad\u0000name" }), state);
    assert.equal(result.rootQuarantine?.code, "NUL_CHARACTER_UNSUPPORTED");
  });

  it("never truncates a non-integer or out-of-range counter", () => {
    assert.deepEqual(readIntValue(2.5, "users.mock"), { ok: false, code: "NON_INTEGER_NUMBER", field: "users.mock", observedType: "number" });
    const big = readIntValue(2 ** 31, "users.mock");
    assert.equal(big.ok, false);
    assert.equal(!big.ok && big.code, "INTEGER_OUT_OF_RANGE");
    assert.deepEqual(readIntValue(7, "users.mock"), { ok: true, value: 7 });
  });

  it("flags case-insensitive duplicate emails without merging or dropping either user", () => {
    const world = buildWorld();
    const state = primedState(world);
    const a = transformUser(userDoc(world.ids.userA, { email: "Same@Example.com" }), state);
    const b = transformUser(userDoc(world.ids.userB, { email: "same@example.COM" }), state);
    assert.ok(a.rows!.users && b.rows!.users);
    const groups = state.emailDuplicateGroups();
    assert.equal(groups.length, 1);
    assert.deepEqual([...groups[0]!.memberIds].sort(), [world.ids.userA.toHexString(), world.ids.userB.toHexString()].sort());
  });
});

describe("Stage 14 deterministic identity and conversions", () => {
  it("derives the same child ids for the same natural key and different ids for different keys", () => {
    assert.equal(deterministicUuid("feedback_entry:u:k:0"), deterministicUuid("feedback_entry:u:k:0"));
    assert.notEqual(deterministicUuid("feedback_entry:u:k:0"), deterministicUuid("feedback_entry:u:k:1"));
    assert.match(deterministicUuid("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("transforming the same user twice yields byte-identical rows (child ids are stable)", () => {
    const world = buildWorld();
    const first = transformUser(world.userA, primedState(world));
    const second = transformUser(world.userA, primedState(world));
    assert.deepEqual(first.rows, second.rows);
  });

  it("accepts only real calendar dates", () => {
    assert.equal(parseCalendarDate("2024-02-29")?.toISOString(), "2024-02-29T00:00:00.000Z");
    assert.equal(parseCalendarDate("2023-02-29"), undefined);
    assert.equal(parseCalendarDate("2024-13-01"), undefined);
    assert.equal(parseCalendarDate("01/02/2024"), undefined);
  });

  it("converts BSON values for JSONB without losing them and refuses unsupported types", () => {
    const id = new ObjectId();
    const date = new Date("2024-01-01T00:00:00.000Z");
    assert.deepEqual(toJsonValue({ id, date, n: 1, nested: [1, "a", null] }), { id: id.toHexString(), date: date.toISOString(), n: 1, nested: [1, "a", null] });
    assert.throws(() => toJsonValue({ f: () => 1 }));
  });
});
