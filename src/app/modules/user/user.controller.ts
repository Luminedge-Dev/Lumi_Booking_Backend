import type { Request, Response } from "express";
import type { UserService } from "./user.service";
import { parseRequestProfileEditBody } from "./user.validation";

// req/res boundary only -- no Mongo, no authorization logic (already applied
// by the route middleware chain before any of these run). Every branch here
// is a direct, final response write; no custom exception class is needed
// since none of these methods have a deep, multi-layer failure path (unlike
// Auth's register/login, which genuinely needed AuthHttpError).
export class UserController {
  constructor(private readonly userService: UserService) {}

  getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.userService.getUserStatus(req.params.userId);
      res.json(result);
    } catch (err) {
      console.error("Error fetching user status:", err);
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
      console.error("Error fetching profile:", err);
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
      console.error("Error fetching user mock data:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  };

  requestProfileEdit = async (req: Request, res: Response): Promise<void> => {
    try {
      // Re-parses rather than trusting a stashed req property -- the
      // validation middleware already guaranteed this succeeds by the time
      // this runs (user.route.ts), and re-parsing is cheap/pure.
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
      console.error("Error requesting profile edit:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };

  listProfileEditRequests = async (_req: Request, res: Response): Promise<void> => {
    try {
      const users = await this.userService.listProfileEditRequests();
      res.status(200).json({ success: true, users });
    } catch (err) {
      console.error("Error fetching requested users:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  };
}
