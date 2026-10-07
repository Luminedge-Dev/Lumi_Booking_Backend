import type { Request, Response } from "express";
import { logger } from "../../shared/logger/logger";
import type { UserService } from "./user.service";
import { parseRequestProfileEditBody } from "./user.validation";

export class UserController {
  constructor(private readonly userService: UserService) {}

  getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.userService.getUserStatus(req.params.userId);
      res.json(result);
    } catch (err) {
      logger.error("user_status_error", { error: (err as Error)?.message });
      res.status(500).json({ message: "Failed to load user status." });
    }
  };

  getProfile = async (req: Request, res: Response): Promise<void> => {
    try {
      const profile = await this.userService.getProfile(req.params.userId);
      if (!profile) {
        res.status(404).json({ success: false, message: "User not found" });
        return;
      }
      res.json({ success: true, user: profile });
    } catch (err) {
      logger.error("user_profile_error", { error: (err as Error)?.message });
      res.status(500).json({ success: false, message: "Server error" });
    }
  };

  getUserSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      const summary = await this.userService.getUserSummary(req.params.userId);
      if (!summary) {
        res.status(404).json({ success: false, message: "User not found" });
        return;
      }
      res.json(summary);
    } catch (err) {
      logger.error("user_summary_error", { error: (err as Error)?.message });
      res.status(500).json({ success: false, message: "Server error" });
    }
  };

  requestProfileEdit = async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = parseRequestProfileEditBody(req.body);
      if (!parsed) {
        res.status(400).json({ success: false, message: "Invalid or missing userId" });
        return;
      }
      const { modified } = await this.userService.requestProfileEdit(parsed.userId, parsed.note);
      if (modified) {
        res.status(200).json({ success: true, message: "Profile change request submitted" });
        return;
      }
      res.status(404).json({ success: false, message: "User not found or already requested" });
    } catch (err) {
      logger.error("user_profile_edit_request_error", { error: (err as Error)?.message });
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };

  listProfileEditRequests = async (_req: Request, res: Response): Promise<void> => {
    try {
      const users = await this.userService.listProfileEditRequests();
      res.status(200).json({ success: true, users });
    } catch (err) {
      logger.error("user_profile_edit_list_error", { error: (err as Error)?.message });
      res.status(500).json({ success: false, message: "Server error" });
    }
  };
}
