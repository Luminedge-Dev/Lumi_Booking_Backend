import type { NextFunction, Request, Response } from "express";
import { logger } from "../../shared/logger/logger";
import type { BookingService } from "./booking.service";
import { BookingError, BookingQueryTimeoutError } from "./booking.types";

const asBody = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};

export class BookingController {
  constructor(private readonly service: BookingService) {}

  // Domain errors carry the exact legacy HTTP contract; anything else is the
  // endpoint's own legacy generic 500 body.
  private respondError(res: Response, error: unknown, event: string, genericBody: Record<string, unknown>): void {
    if (error instanceof BookingError) {
      res.status(error.status).json(error.body);
      return;
    }
    logger.error(event, { error: (error as Error)?.message, kind: (error as Error)?.name });
    res.status(500).json(genericBody);
  }

  bookSlot = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.bookSlot(req.user ?? {}, asBody(req)));
    } catch (error) {
      this.respondError(res, error, "booking_book_slot_error", { success: false, message: "Internal server error" });
    }
  };

  cancel = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.cancel(req.user ?? {}, req.params.bookingId));
    } catch (error) {
      this.respondError(res, error, "booking_cancel_error", { message: "Internal server error" });
    }
  };

  listForUser = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.listForUser(req.user ?? {}, req.params.userId));
    } catch (error) {
      this.respondError(res, error, "booking_list_user_error", { message: "Failed to load bookings." });
    }
  };

  listHomeWithUsers = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.listHomeWithUsers());
    } catch (error) {
      this.respondError(res, error, "booking_home_with_users_error", { message: "Internal Server Error" });
    }
  };

  // Legacy: timeout -> 504; every other failure goes to the shared error handler.
  listBySchedule = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await this.service.listBySchedule(String(req.params.scheduleId || ""), req.query as Record<string, unknown>));
    } catch (error) {
      if (error instanceof BookingError) {
        res.status(error.status).json(error.body);
        return;
      }
      if (error instanceof BookingQueryTimeoutError) {
        res.status(504).json({ message: "Query took too long for this page/limit." });
        return;
      }
      next(error);
    }
  };

  listAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await this.service.listAdmin(req.query as Record<string, unknown>));
    } catch (error) {
      if (error instanceof BookingError) {
        res.status(error.status).json(error.body);
        return;
      }
      if (error instanceof BookingQueryTimeoutError) {
        res.status(504).json({ message: "Query took too long. Try a smaller page/limit." });
        return;
      }
      next(error);
    }
  };

  attendanceBulk = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.attendanceCounts(asBody(req).userIds));
    } catch (error) {
      this.respondError(res, error, "booking_attendance_bulk_error", { error: "Internal server error" });
    }
  };

  updateAttendance = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.updateAttendance(req.params.scheduleId, asBody(req));
      res.json(result);
    } catch (error) {
      this.respondError(res, error, "booking_attendance_update_error", { message: "Error updating attendance" });
    }
  };

  assignTeacher = async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json(await this.service.assignTeacher(req.params.bookingId, asBody(req)));
    } catch (error) {
      this.respondError(res, error, "booking_assign_teacher_error", { message: "Internal server error" });
    }
  };
}
