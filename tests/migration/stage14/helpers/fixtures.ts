// Hand-built Stage 14 fixtures. Never derived from, or compared against, a real database.

import { ObjectId } from "mongodb";
import type { RawDoc } from "../../../../scripts/migration/stage14/common";

export interface World {
  course: RawDoc;
  schedule: RawDoc;
  userA: RawDoc;
  userB: RawDoc;
  testCenterBooking: RawDoc;
  homeBooking: RawDoc;
  ids: { course: ObjectId; schedule: ObjectId; userA: ObjectId; userB: ObjectId; tcBooking: ObjectId; homeBooking: ObjectId };
}

const T0 = new Date("2024-01-01T00:00:00.000Z");
const T1 = new Date("2024-01-02T00:00:00.000Z");

export function userDoc(_id: ObjectId, overrides: RawDoc = {}): RawDoc {
  return {
    _id,
    name: "Jane Doe",
    email: `${_id.toHexString()}@example.com`,
    role: "user",
    status: "active",
    isDeleted: false,
    createdAt: T0,
    updatedAt: T1,
    password: "hashed-password",
    mock: 2,
    totalMock: 5,
    dateOfBirth: "1995-06-15",
    contactNo: "01700000000",
    passportNumber: "A12345678",
    sex: "F",
    result: [],
    profileChangeRequestStatus: "default",
    ...overrides,
  };
}

export function buildWorld(idPrefix = "65000000000000000000"): World {
  const ids = {
    course: new ObjectId(`${idPrefix}00c1`),
    schedule: new ObjectId(`${idPrefix}00a1`),
    userA: new ObjectId(`${idPrefix}00b1`),
    userB: new ObjectId(`${idPrefix}00b2`),
    tcBooking: new ObjectId(`${idPrefix}00d1`),
    homeBooking: new ObjectId(`${idPrefix}00d2`),
  };
  const course: RawDoc = { _id: ids.course, name: "IELTS Academic", image: "https://example.com/i.png", homeBasedSystems: ["Zoom"], createdAt: T0, updatedAt: T1 };
  const schedule: RawDoc = {
    _id: ids.schedule,
    name: "Jan Batch",
    courseId: ids.course,
    createdAt: T0,
    testType: "Computer-Based",
    testSystem: "Academic",
    status: "Scheduled",
    startDate: "2024-02-01",
    endDate: "2024-02-01",
    timeSlots: [
      { slot: 18, slotId: "1", totalSlot: 20, startTime: "09:00", endTime: "11:00" },
      { slot: 20, slotId: "2", totalSlot: 20, startTime: "12:00", endTime: "14:00" },
    ],
  };
  const userA = userDoc(ids.userA, {
    mocks: [
      { createdAt: T0, mock: 1, mockType: "IELTS Academic", mrValidation: "2024-06-01", testSystem: "Academic", testType: "Computer-Based", transactionId: "TXN-1" },
      { createdAt: T1, mock: 4, mockType: "IELTS Academic", mrValidation: "2024-09-01", testSystem: "Academic", testType: "Paper-Based", transactionId: "TXN-2" },
    ],
    resultsBySchedule: {
      [ids.schedule.toHexString()]: [{ segment: "Listening", feedback: "good", marks: { raw: 30 }, admin: "t@example.com", timestamp: T1 }],
    },
    feedbackStatusBySchedule: { [ids.schedule.toHexString()]: { Listening: true, Reading: false } },
    adminSectionBySchedule: { [ids.homeBooking.toHexString()]: { overallScore: "7.5", proficiencyLevel: "C1", updatedAt: T1 } },
    teachersBySchedule: {
      [ids.schedule.toHexString()]: { teacherL: "Ms L", teacherLEmail: "l@example.com" },
      [ids.homeBooking.toHexString()]: { teacherR: "Mr R", teacherREmail: "r@example.com" },
    },
    trfEmailsBySchedule: {
      [ids.schedule.toHexString()]: {
        lastSentAt: T1,
        lastSubject: "Your TRF",
        lastFilename: "trf.pdf",
        to: "u@example.com",
        history: [{ at: T0, subject: "Your TRF", filename: "trf.pdf", to: "u@example.com" }, { at: T1, subject: "Again", filename: "trf2.pdf", to: "u@example.com" }],
      },
    },
  });
  const userB = userDoc(ids.userB, { email: "Second@Example.com" });
  const testCenterBooking: RawDoc = {
    _id: ids.tcBooking,
    userId: ids.userA,
    scheduleId: ids.schedule,
    slotId: "1",
    name: "IELTS Academic",
    location: "Test Center",
    bookingDate: "2024-02-01",
    status: "Present",
    attendance: "present",
    testType: "Computer-Based",
    testSystem: "Academic",
    startTime: "09:00",
    endTime: "11:00",
  };
  const homeBooking: RawDoc = {
    _id: ids.homeBooking,
    userId: ids.userA,
    name: "IELTS Academic",
    location: "Home",
    bookingDate: "2024-02-02",
    status: "pending",
    testType: "Computer-Based",
    testTime: "09:00",
  };
  return { course, schedule, userA, userB, testCenterBooking, homeBooking, ids };
}

export function worldSource(world: World) {
  return {
    users: [world.userA, world.userB],
    courses: [world.course],
    schedules: [world.schedule],
    bookingMock: [world.testCenterBooking, world.homeBooking],
  };
}
