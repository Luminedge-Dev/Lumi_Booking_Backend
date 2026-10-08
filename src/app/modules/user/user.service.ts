import type { UserRepository } from "./user.repository";
import { toProfileDto, toProfileEditRequestDto, toUserStatusResponse, toUserSummaryDto } from "./user.mapper";
import type { ProfileEditRequestRecord, UserProfileDto, UserStatusRecord, UserSummaryDto } from "./user.types";

export class UserService {
  constructor(private readonly repository: UserRepository) {}

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
}
