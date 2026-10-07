import type { NextFunction, Request, Response } from "express";
import { ObjectId } from "mongodb";
import { logger } from "../../shared/logger/logger";
import type { ScheduleService } from "./schedule.service";
import { parseMonthParam, parsePaginationParams, parseAdminListFilter } from "./schedule.validation";
import { ScheduleQueryTimeoutError } from "./schedule.types";

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
      logger.error("schedule_create_error", { error: (err as Error)?.message });
      res.status(500).json({ success: false, message: "Server error while creating schedules" });
    }
  };

  getByDateAndCourse = async (req: Request, res: Response): Promise<void> => {
    try {
      const { date, courseId } = req.params;
      const schedules = await this.service.getByDateAndCourse(date, courseId);
      res.json({ schedules });
    } catch (err) {
      logger.error("schedule_date_read_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Failed to load schedules" });
    }
  };

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
      logger.error("schedule_month_read_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Failed to load schedules" });
    }
  };

  // Only this endpoint maps ScheduleQueryTimeoutError to 504; other errors fall through to next(err).
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

  getByUserId = async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const schedules = await this.service.getByUserId(userId);
      res.json({ schedules });
    } catch (err) {
      logger.error("schedule_user_read_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Failed to load schedules." });
    }
  };

  deleteSchedule = async (req: Request, res: Response): Promise<void> => {    const { id } = req.params;
    try {
      const deleted = await this.service.deleteById(id);
      if (!deleted) {
        res.status(404).json({ message: "Schedule not found" });
        return;
      }
      res.json({ success: true, message: "Schedule deleted successfully" });
    } catch (err) {
      logger.error("schedule_delete_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Error deleting schedule" });
    }
  };
}
