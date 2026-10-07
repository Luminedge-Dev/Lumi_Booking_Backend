import type { Collection, Document } from "mongodb";
import { ObjectId } from "mongodb";
import { measureDatabaseOperation } from "../../database/query-timing";
import { ScheduleQueryTimeoutError } from "./schedule.types";
import type { AdminListFilter, AdminListParams, MonthRange, ScheduleRecord, SlotIdKey } from "./schedule.types";

export class ScheduleRepository {
  constructor(private readonly schedulesCollection: Collection<Document>) {}

  async findMaxSlotId(key: SlotIdKey): Promise<number> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.max_slot_id" }, async () => {
      const [row] = await this.schedulesCollection
        .aggregate(
          [
            { $match: key as Document },
            { $unwind: "$timeSlots" },
            {
              $project: {
                n: {
                  $toInt: {
                    $ifNull: [
                      {
                        $cond: [
                          { $isNumber: "$timeSlots.slotId" },
                          "$timeSlots.slotId",
                          { $toInt: { $ifNull: ["$timeSlots.slotId", 0] } },
                        ],
                      },
                      0,
                    ],
                  },
                },
              },
            },
            { $group: { _id: null, maxId: { $max: "$n" } } },
            { $project: { _id: 0, maxId: 1 } },
          ],
          { maxTimeMS: 5000 }
        )
        .toArray();
      return (row?.maxId as number | undefined) ?? 0;
    });
  }

  async insertSchedule(doc: Record<string, unknown>): Promise<void> {
    await measureDatabaseOperation({ collection: "schedules", operation: "schedule.insert" }, async () => {
      await this.schedulesCollection.insertOne(doc as Document);
    });
  }

  async findByDateAndCourse(date: string, courseId: string): Promise<ScheduleRecord[]> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.find_by_date_course" }, async () => {
      const docs = await this.schedulesCollection
        .aggregate(
          [
            { $match: { courseId, startDate: date, endDate: date, status: { $ne: "Cancelled" } } },
            {
              $addFields: {
                _slotIdNum: {
                  $cond: [
                    { $gt: [{ $size: "$timeSlots" }, 0] },
                    {
                      $toInt: {
                        $ifNull: [
                          {
                            $cond: [
                              { $isNumber: { $arrayElemAt: ["$timeSlots.slotId", 0] } },
                              { $arrayElemAt: ["$timeSlots.slotId", 0] },
                              { $toInt: { $arrayElemAt: ["$timeSlots.slotId", 0] } },
                            ],
                          },
                          0,
                        ],
                      },
                    },
                    0,
                  ],
                },
              },
            },
            { $sort: { _slotIdNum: 1, startDate: 1, _id: 1 } },
            { $project: { _slotIdNum: 0 } },
          ],
          { maxTimeMS: 8000 }
        )
        .toArray();
      return docs as unknown as ScheduleRecord[];
    });
  }

  async findByCourseAndMonth(courseId: string, range: MonthRange): Promise<ScheduleRecord[]> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.find_by_course_month" }, async () => {
      const docs = await this.schedulesCollection
        .find({
          courseId,
          startDate: { $gte: range.startInclusive, $lt: range.endExclusive },
          status: { $ne: "Cancelled" },
        } as Document)
        .toArray();
      return docs as unknown as ScheduleRecord[];
    });
  }

  // Maps Mongo code-50 to ScheduleQueryTimeoutError; the controller owns the 504 mapping.
  async listAdmin(filter: AdminListFilter, params: AdminListParams): Promise<ScheduleRecord[]> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.list_admin" }, async () => {
      try {
        const docs = await this.schedulesCollection
          .find(filter as Document)
          .sort({ _id: -1 })
          .skip(params.skip)
          .limit(params.limit)
          .maxTimeMS(8000)
          .toArray();
        return docs as unknown as ScheduleRecord[];
      } catch (err) {
        if ((err as { code?: number } | undefined)?.code === 50) {
          throw new ScheduleQueryTimeoutError();
        }
        throw err;
      }
    });
  }

  async countAdmin(filter: AdminListFilter): Promise<number> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.count_admin" }, async () => {
      try {
        return await this.schedulesCollection.countDocuments(filter as Document, { maxTimeMS: 3000 });
      } catch (err) {
        if ((err as { code?: number } | undefined)?.code === 50) {
          throw new ScheduleQueryTimeoutError();
        }
        throw err;
      }
    });
  }

  async deleteById(id: string): Promise<boolean> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.delete" }, async () => {
      const result = await this.schedulesCollection.deleteOne({ _id: new ObjectId(id) } as Document);
      return result.deletedCount > 0;
    });
  }

  // Raw-string userId match with no ObjectId coercion, matching legacy.
  async findByUserId(userId: string): Promise<ScheduleRecord[]> {
    return measureDatabaseOperation({ collection: "schedules", operation: "schedule.find_by_user" }, async () => {
      const docs = await this.schedulesCollection.find({ userId } as Document).toArray();
      return docs as unknown as ScheduleRecord[];
    });
  }
}
