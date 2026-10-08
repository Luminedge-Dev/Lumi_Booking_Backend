import type { Request, Response } from "express";
import { logger } from "../../shared/logger/logger";
import type { UserService } from "./user.service";
import { UserHttpError } from "./user.types";
import { isStorableNote, parseRequestProfileEditBody } from "./user.validation";

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
      if (!isStorableNote(parsed.note)) {
        res.status(400).json({ success: false, message: "Invalid note" });
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

  private respond(res: Response, error: unknown, event: string, generic: Record<string, unknown>): void {
    if (error instanceof UserHttpError) {
      res.status(error.status).json(error.body);
      return;
    }
    logger.error(event, { error: (error as Error)?.message });
    res.status(500).json(generic);
  }

  grantMocks = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.userService.grantMocks(req.params.userId, req.body));
    } catch (error) {
      this.respond(res, error, "user_grant_mocks_error", { success: false, message: "Server error" });
    }
  };

  adjustMock = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.userService.adjustMock(req.params.userId, req.body));
    } catch (error) {
      this.respond(res, error, "user_adjust_mock_error", { success: false, message: "Server error" });
    }
  };

  updateStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.userService.updateStatus(req.params.userId, req.body));
    } catch (error) {
      this.respond(res, error, "user_update_status_error", { message: "Error updating user status." });
    }
  };

  updateBlock = async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.userService.updateBlock(req.params.userId, req.body));
    } catch (error) {
      this.respond(res, error, "user_update_block_error", { message: "Error updating user status" });
    }
  };

  approveProfileEdit = async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json(await this.userService.approveProfileEdit(req.params.userId, req.body));
    } catch (error) {
      this.respond(res, error, "user_approve_profile_error", { success: false, message: "Server error" });
    }
  };
}
