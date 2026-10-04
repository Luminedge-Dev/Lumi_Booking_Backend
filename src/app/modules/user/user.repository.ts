import type { Collection, Document } from "mongodb";
import { ObjectId } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import type {
  ProfileEditRequestRecord,
  UserProfileRecord,
  UserStatusRecord,
  UserSummarySourceRecord,
} from "./user.types";

// The only file in this module touching usersCollection directly. Callers
// (service) must have already validated userId is a well-formed ObjectId
// string -- route-level validation/authorization runs before these are ever
// called (AGENTS.md layer rules: repositories don't decide authorization
// policy, and don't re-validate what the route chain already guaranteed).
export class UserRepository {
  constructor(private readonly usersCollection: Collection<Document>) {}

  async findStatusById(userId: string): Promise<UserStatusRecord | null> {
    return measureDatabaseOperation({ collection: "users", operation: "user.find_status_by_id" }, async () => {
      const doc = await this.usersCollection.findOne(
        { _id: new ObjectId(userId) },
        { projection: { password: 0 } }
      );
      return doc as unknown as UserStatusRecord | null;
    });
  }

  async findProfileById(userId: string): Promise<UserProfileRecord | null> {
    return measureDatabaseOperation({ collection: "users", operation: "user.find_profile_by_id" }, async () => {
      const doc = await this.usersCollection.findOne(
        { _id: new ObjectId(userId) },
        {
          projection: {
            name: 1,
            email: 1,
            contactNo: 1,
            passportNumber: 1,
            transactionId: 1,
            createdAt: 1,
            profileChangeRequestStatus: 1,
          },
        }
      );
      return doc as unknown as UserProfileRecord | null;
    });
  }

  async findSummaryById(userId: string): Promise<UserSummarySourceRecord | null> {
    return measureDatabaseOperation({ collection: "users", operation: "user.find_summary_by_id" }, async () => {
      const doc = await this.usersCollection.findOne({ _id: new ObjectId(userId) });
      return doc as unknown as UserSummarySourceRecord | null;
    });
  }

  async findProfileEditRequests(): Promise<ProfileEditRequestRecord[]> {
    return measureDatabaseOperation({ collection: "users", operation: "user.find_profile_requests" }, async () => {
      const docs = await this.usersCollection
        .find({ profileChangeRequestStatus: "requested" })
        .project({
          _id: 1,
          name: 1,
          email: 1,
          profileChangeRequestStatus: 1,
          profileEditNote: 1,
          contactNo: 1,
          passportNumber: 1,
          transactionId: 1,
        })
        .toArray();
      return docs as unknown as ProfileEditRequestRecord[];
    });
  }

  async submitProfileEditRequest(userId: string, note: unknown): Promise<{ modifiedCount: number }> {
    return measureDatabaseOperation({ collection: "users", operation: "user.request_profile_edit" }, async () => {
      const result = await this.usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { profileChangeRequestStatus: "requested", profileEditNote: note } }
      );
      return { modifiedCount: result.modifiedCount };
    });
  }
}
