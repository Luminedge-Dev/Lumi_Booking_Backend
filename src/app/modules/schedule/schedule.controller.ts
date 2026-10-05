import type { NextFunction, Request, Response } from "express";
import { ObjectId } from "mongodb";
import type { ScheduleService } from "./schedule.service";
import { parseMonthParam, parsePaginationParams, parseAdminListFilter } from "./schedule.validation";
import { ScheduleQueryTimeoutError } from "./schedule.types";

// req/res boundary only -- maps service-layer results to the exact legacy
// status/body. No Mongo, no business logic.
export class ScheduleController {
  constructor(private readonly service: ScheduleService) {}

  createSchedule = async (req: Request, res: Response): Promise<void> => {
    const payload = Array.isArray(req.body) ? req.body : [];
    try {
      const { successful, failed } = await this.service.createSchedules(payload);

      if (!successful.length) {
        res.status(409).json({
          success: false,
          message: "No schedules created.",
          successfulSchedules: successful,
          failedSchedules: failed,
        });
        return;
      }

      res.status(failed.length ? 207 : 201).json({
        success: true,
        message: failed.length ? "Schedules created (some skipped)." : "Schedules created successfully.",
        successfulSchedules: successful,
        failedSchedules: failed,
      });
    } catch (err) {
      console.error("create-schedule error:", err);
      res.status(500).json({ success: false, message: "Server error while creating schedules" });
    }
  };

  getByDateAndCourse = async (req: Request, res: Response): Promise<void> => {
    try {
      const { date, courseId } = req.params;
      const schedules = await this.service.getByDateAndCourse(date, courseId);
      res.json({ schedules });
    } catch (err) {
      console.error("schedule by date error:", err);
      res.status(500).json({ message: "Failed to load schedules" });
    }
  };

  // New Stage 9 contract. Re-derives/re-validates month + courseId here
  // (cheap, pure) rather than trusting a value stashed on req by route
  // middleware -- same pattern Stage 8's controller used for
  // request-profile-edit's body. Canonicalizes a valid ObjectId-shaped
  // courseId to its hex string before matching the persisted STRING
  // courseId field.
  getByCourseAndMonth = async (req: Request, res: Response): Promise<void> => {
    const range = parseMonthParam(req.query.month);
    if (!range) {
      res.status(400).json({ message: "Invalid month. Expected YYYY-MM." });
      return;
    }
    const courseIdParam = req.params.courseId;
    if (typeof courseIdParam !== "string" || !ObjectId.isValid(courseIdParam)) {
      res.status(400).json({ message: "Invalid course ID." });
      return;
    }
    try {
      const canonicalCourseId = new ObjectId(courseIdParam).toHexString();
      const schedules = await this.service.getByCourseAndMonth(canonicalCourseId, range);
      res.json({ schedules });
    } catch (err) {
      console.error("schedule by month error:", err);
      res.status(500).json({ message: "Failed to load schedules" });
    }
  };

  // The ONLY place that knows ScheduleQueryTimeoutError means
  // 504 {message:"Query timed out."} for this endpoint specifically.
  // Any other error falls through to next(err) -- the shared error
  // handler, matching legacy's own next(err) fallthrough exactly.
  listAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { page, limit, skip } = parsePaginationParams(req.query as Record<string, unknown>);
      const filter = parseAdminListFilter(req.query as Record<string, unknown>);
      const result = await this.service.listAdmin(filter, { page, limit, skip });
      res.json(result);
    } catch (err) {
      if (err instanceof ScheduleQueryTimeoutError) {
        res.status(504).json({ message: "Query timed out." });
        return;
      }
      next(err);
    }
  };

  deleteSchedule = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const deleted = await this.service.deleteById(id);
      if (!deleted) {
        res.status(404).json({ message: "Schedule not found" });
        return;
      }
      res.json({ success: true, message: "Schedule deleted successfully" });
    } catch (err) {
      console.error("Error deleting schedule:", err);
      res.status(500).json({ message: "Error deleting schedule" });
    }
  };
}
