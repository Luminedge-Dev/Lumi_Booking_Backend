// Direct unit tests for src/app/modules/user/user.mapper.ts -- this file
// owns ALL response-shape transformation for the module, so these tests
// exercise the real logic (not a service-layer stand-in).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { toProfileDto, toProfileEditRequestDto, toUserStatusResponse, toUserSummaryDto } from "../../../src/app/modules/user/user.mapper";
import type { UserProfileRecord, UserStatusRecord, UserSummarySourceRecord } from "../../../src/app/modules/user/user.types";

describe("toUserStatusResponse (full-document-minus-password passthrough)", () => {
  it("passes through arbitrary fields unchanged, including dateofbirth (not dateOfBirth)", () => {
    const record = {
      _id: new ObjectId(),
      email: "user@example.test",
      dateofbirth: "1990-01-01",
      someUnexpectedLegacyField: "legacy-value",
    } as unknown as UserStatusRecord;
    const result = toUserStatusResponse(record);
    assert.equal(result.user?.dateofbirth, "1990-01-01");
    assert.equal(result.user?.someUnexpectedLegacyField, "legacy-value");
  });

  it("null record -> {user: null}, not an error", () => {
    assert.deepEqual(toUserStatusResponse(null), { user: null });
  });

  it("never introduces a password field itself (repository already excludes it)", () => {
    const record = { _id: new ObjectId(), email: "user@example.test" } as unknown as UserStatusRecord;
    const result = toUserStatusResponse(record);
    assert.ok(!Object.prototype.hasOwnProperty.call(result.user, "password"));
  });
});

describe("toProfileDto (contactNo/phone + passportNumber/passportId aliasing)", () => {
  it("contactNo-only -> phone alias exposed", () => {
    const record: UserProfileRecord = { _id: new ObjectId(), contactNo: "0123456789" };
    assert.equal(toProfileDto(record).phone, "0123456789");
  });

  it("passportNumber-only -> passportId alias exposed", () => {
    const record: UserProfileRecord = { _id: new ObjectId(), passportNumber: "P12345" };
    assert.equal(toProfileDto(record).passportId, "P12345");
  });
});

describe("toUserSummaryDto (lastMock -> root -> N/A fallback chain)", () => {
  it("mocks[] present -> lastMock is the last element", () => {
    const record: UserSummarySourceRecord = {
      _id: new ObjectId(),
      mocks: [{ transactionId: "TXN-1" }, { transactionId: "TXN-2" }],
    };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.lastMock?.transactionId, "TXN-2");
    assert.equal(dto.user.transactionId, "TXN-2");
  });

  it("mocks[] empty -> lastMock is null, root fallback used", () => {
    const record: UserSummarySourceRecord = { _id: new ObjectId(), mocks: [], transactionId: "ROOT-TXN" };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.lastMock, null);
    assert.equal(dto.user.transactionId, "ROOT-TXN");
  });

  it("lastMock missing a field -> falls back to root field", () => {
    const record: UserSummarySourceRecord = {
      _id: new ObjectId(),
      mocks: [{ transactionId: "TXN-1" }],
      mockType: "ROOT-TYPE",
    };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.user.mockType, "ROOT-TYPE");
  });

  it("missing both lastMock field and root field -> \"N/A\"", () => {
    const record: UserSummarySourceRecord = { _id: new ObjectId(), mocks: [{ transactionId: "TXN-1" }] };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.user.mockType, "N/A");
  });

  it("mock/totalMock zero preserved as zero, not falsy-coalesced to \"N/A\" or default", () => {
    const record: UserSummarySourceRecord = { _id: new ObjectId(), mock: 0, totalMock: 0 };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.user.mock, 0);
    assert.equal(dto.user.totalMock, 0);
  });

  it("name/email default to legacy's exact fallback strings when absent", () => {
    const record: UserSummarySourceRecord = { _id: new ObjectId() };
    const dto = toUserSummaryDto(record);
    assert.equal(dto.user.name, "Unknown User");
    assert.equal(dto.user.email, "No Email");
  });
});

describe("toProfileEditRequestDto (passthrough)", () => {
  it("returns a shallow copy with all fields intact", () => {
    const record = { _id: new ObjectId(), name: "A", profileChangeRequestStatus: "requested" };
    const dto = toProfileEditRequestDto(record);
    assert.deepEqual(dto, record);
    assert.notEqual(dto, record);
  });
});
