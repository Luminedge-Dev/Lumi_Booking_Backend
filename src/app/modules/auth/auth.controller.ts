import type { NextFunction, Request, Response } from "express";
import { AuthHttpError, type AuthService } from "./auth.service";
import {
  parseChangePasswordBody,
  parseForgotPasswordBody,
  parseLoginBody,
  parseRegisterBody,
  parseResetPasswordBody,
} from "./auth.validation";
import type { AuthEmailSender } from "./auth.types";

// Express req/res boundary + exact legacy status/body mapping. No direct
// MongoDB access (AGENTS.md layer rules) -- all business logic lives in
// AuthService; AuthHttpError thrown by the service/validation layer is
// mapped verbatim to res.status(status).json(body) here, never through the
// shared AppError/errorHandler path (see auth.middleware.ts's comment on why).
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly emailSender: AuthEmailSender,
    private readonly isProduction: boolean
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = parseRegisterBody(req.body);
      const result = await this.authService.register(input);
      res.status(201).json({ message: "User registered successfully", userId: result.userId });
      // Fire-and-forget, after the response -- matches
      // auth.routes.js:92's ordering (res.status(201).json(...) before
      // waitUntil(...)).
      this.emailSender.sendWelcomeEmail(result.normalizedEmail, result.name);
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      console.error("Error during registration process:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = parseLoginBody(req.body);
      const result = await this.authService.login(input);

      res.cookie("token", result.token, {
        httpOnly: true,
        maxAge: result.sessionMs,
        secure: this.isProduction,
        sameSite: this.isProduction ? "none" : "lax",
      });

      res.json({
        success: true,
        accessToken: result.token,
        email: result.email,
        role: result.role,
        userId: result.userId,
      });
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      // Legacy login's catch-all calls next(error) rather than writing a
      // response directly (auth.routes.js:153-155) -- preserved here so an
      // unexpected failure still flows through the app's error-handling
      // middleware instead of a bespoke body.
      next(error);
    }
  };

  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = parseForgotPasswordBody(req.body);
      const dispatch = await this.authService.prepareForgotPassword(input);

      // SECURITY: identical response whether or not the account exists, so
      // this endpoint can't be used to enumerate registered emails.
      res.json({ success: true, message: "Password reset link sent successfully" });

      // Fire-and-forget, AFTER the response -- matches
      // auth.routes.js:207-225's exact ordering.
      if (dispatch.found) {
        this.emailSender.sendPasswordResetEmail(dispatch.email as string, dispatch.name, dispatch.resetLink as string);
      }
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      console.error("Error in forget-password route:", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = parseResetPasswordBody(req.body);
      await this.authService.resetPassword(input);
      res.json({ success: true, message: "Password reset successfully" });
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      console.error("Error in reset-password route:", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = parseChangePasswordBody(req.body);
      await this.authService.changePassword(req.user?.email, input);
      res.json({ message: "Password changed successfully!" });
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      console.error("change-password error:", error);
      res.status(500).json({ message: "Server error" });
    }
  };
}
