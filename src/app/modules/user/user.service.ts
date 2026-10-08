import { logger } from "../../shared/logger/logger";
import { normalizeEmailIdentity } from "../../shared/email-identity";
import type { UserRepository } from "./user.repository";
import { toProfileDto, toProfileEditRequestDto, toUserStatusResponse, toUserSummaryDto } from "./user.mapper";
import { addInt4, getFutureISODate, parseApproveEmail, parseMockAmount } from "./user.validation";
import {
  ALLOWED_USER_STATUSES,
  UserHttpError,
  type AllowedUserStatus,
  type MockGrantEntry,
  type ProfileEditRequestRecord,
  type UserProfileDto,
  type UserStatusRecord,
  type UserSummaryDto,
} from "./user.types";

export interface UserNotifier {
  mocksGranted(user: { name: string; email: string }, addedMocks: MockGrantEntry[]): void;
  accountCompleted(user: { name: string; email: string }): void;
}

const fail = (status: number, body: Record<string, unknown>): UserHttpError => new UserHttpError(status, body);

export class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly notifier: UserNotifier = { mocksGranted() {}, accountCompleted() {} }
  ) {}

  async getUserStatus(userId: string): Promise<{ user: UserStatusRecord | null }> {
    const record = await this.repository.findStatusById(userId);
    return toUserStatusResponse(record);
  }

  async getProfile(userId: string): Promise<UserProfileDto | null> {
    const record = await this.repository.findProfileById(userId);
    return record ? toProfileDto(record) : null;
  }

  async getUserSummary(userId: string): Promise<UserSummaryDto | null> {
    const record = await this.repository.findSummaryById(userId);
    return record ? toUserSummaryDto(record) : null;
  }

  async requestProfileEdit(userId: string, note: string): Promise<{ modified: boolean }> {
    const { modifiedCount } = await this.repository.submitProfileEditRequest(userId, note);
    return { modified: modifiedCount > 0 };
  }

  async listProfileEditRequests(): Promise<ProfileEditRequestRecord[]> {
    const records = await this.repository.findProfileEditRequests();
    return records.map(toProfileEditRequestDto);
  }

  private safeNotify(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logger.error("user_notifier_error", { label, error: (error as Error)?.message });
    }
  }

  async grantMocks(userId: string, body: unknown): Promise<Record<string, unknown>> {
    const mocks = (body as { mocks?: unknown } | null)?.mocks;
    if (!Array.isArray(mocks) || mocks.length === 0) {
      throw fail(400, { success: false, message: "Mocks must be a non-empty array" });
    }
    const entries: MockGrantEntry[] = [];
    let totalAdd = 0;
    for (const raw of mocks) {
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const amount = parseMockAmount(record.mock);
      if (amount === null) throw fail(400, { success: false, message: "Invalid mock count" });
      const next = addInt4(totalAdd, amount);
      if (next === null) throw fail(400, { success: false, message: "Invalid mock count" });
      totalAdd = next;
      const createdAt = new Date();
      entries.push({
        transactionId: record.transactionId,
        mock: amount,
        mockType: record.mockType,
        testType: record.testType,
        testSystem: record.testSystem,
        mrValidation: record.mrValidation,
        mrValidationExpiry: record.mrValidationExpiry,
        createdAt,
        updatedAt: record.updatedAt,
        emailReminderSent: record.emailReminderSent,
      });
    }
    const outcome = await this.repository.grantMocks(userId, entries);
    if (outcome.kind === "not_found") throw fail(404, { success: false, message: "User not found" });
    if (outcome.kind === "all_duplicates") throw fail(400, { success: false, message: "All transaction IDs are duplicates" });
    if (outcome.kind === "overflow") throw fail(400, { success: false, message: "Invalid mock count" });
    this.safeNotify("mocksGranted", () => this.notifier.mocksGranted({ name: outcome.name, email: outcome.email }, outcome.addedMocks));
    return { success: true, message: "Mocks added; email notification is being sent", addedMocks: outcome.addedMocks };
  }

  async adjustMock(userId: string, body: unknown): Promise<Record<string, unknown>> {
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const updatedMock = payload.updatedMock;
    const transactionId = payload.transactionId;
    if (!updatedMock || !transactionId) {
      throw fail(400, { success: false, message: "Missing updated mock data or transaction ID" });
    }
    const patch = typeof updatedMock === "object" && updatedMock ? (updatedMock as Record<string, unknown>) : {};
    const amount = parseMockAmount(patch.mock);
    if (amount === null) throw fail(400, { success: false, message: "Invalid mock count" });
    const merged = {
      ...patch,
      mock: amount,
      mrValidationExpiry: getFutureISODate(patch.mrValidation),
    };
    const outcome = await this.repository.adjustMock(userId, transactionId, merged, amount);
    if (outcome.kind === "not_found" || outcome.kind === "user_or_mocks_not_found") {
      throw fail(404, { success: false, message: "User or mocks not found" });
    }
    if (outcome.kind === "mock_not_found") throw fail(404, { success: false, message: "Mock with given transaction ID not found" });
    if (outcome.kind === "ambiguous") throw fail(409, { success: false, message: "Ambiguous transaction ID" });
    if (outcome.kind === "total_below_zero") throw fail(400, { success: false, message: "Total mock count cannot go below zero" });
    if (outcome.kind === "overflow") throw fail(400, { success: false, message: "Invalid mock count" });
    return { success: true, message: "Mock updated successfully", updatedMock: outcome.updatedMock };
  }

  async updateStatus(userId: string, body: unknown): Promise<Record<string, unknown>> {
    const status = (body as { status?: unknown } | null)?.status;
    if (typeof status !== "string" || !(ALLOWED_USER_STATUSES as readonly string[]).includes(status)) {
      throw fail(400, { message: `Invalid status. Allowed: ${ALLOWED_USER_STATUSES.join(", ")}` });
    }
    const outcome = await this.repository.updateStatus(userId, status as AllowedUserStatus);
    if (outcome.kind === "not_found") throw fail(404, { message: "User not found" });
    if (outcome.notifyCompleted) {
      this.safeNotify("accountCompleted", () => this.notifier.accountCompleted(outcome.notifyCompleted!));
    }
    return { success: true, message: "User status updated successfully" };
  }

  async updateBlock(userId: string, body: unknown): Promise<Record<string, unknown>> {
    const raw = body && typeof body === "object" ? (body as { isDeleted?: unknown }).isDeleted : undefined;
    const isDeleted = raw === true || raw === "true";
    const outcome = await this.repository.updateBlock(userId, isDeleted);
    if (outcome.kind === "not_found") throw fail(404, { message: "User not found" });
    return { success: true, message: `User ${isDeleted ? "blocked" : "unblocked"} successfully` };
  }

  async approveProfileEdit(userId: string, body: unknown): Promise<Record<string, unknown>> {
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const parsedEmail = parseApproveEmail(payload.email);
    if (!parsedEmail.ok) throw fail(400, { success: false, message: "Invalid email format" });
    const patch = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...("email" in parsedEmail && parsedEmail.ok && !("omitted" in parsedEmail) ? { email: normalizeEmailIdentity(parsedEmail.email) } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.passportId !== undefined ? { passportId: payload.passportId } : {}),
      ...(payload.transactionId !== undefined ? { transactionId: payload.transactionId } : {}),
    };
    const outcome = await this.repository.approveProfileEdit(userId, patch);
    if (outcome.kind === "email_in_use") throw fail(409, { message: "Email address already in use" });
    if (outcome.kind === "not_found" || outcome.kind === "unchanged") {
      throw fail(404, { success: false, message: "User not found or no changes made" });
    }
    return { success: true, message: "User profile updated by admin" };
  }
}
