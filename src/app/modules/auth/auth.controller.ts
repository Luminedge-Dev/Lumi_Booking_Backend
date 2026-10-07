import type { NextFunction, Request, Response } from "express";
import { logger } from "../../shared/logger/logger";
import { AuthHttpError, type AuthService } from "./auth.service";
import {
  parseChangePasswordBody,
  parseForgotPasswordBody,
  parseLoginBody,
  parseRegisterBody,
  parseResetPasswordBody,
} from "./auth.validation";
import type { AuthEmailSender } from "./auth.types";

// AuthHttpError is mapped verbatim to res.status(status).json(body) here,
// never through the shared AppError/errorHandler path.
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
      this.emailSender.sendWelcomeEmail(result.normalizedEmail, result.name);
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      logger.error("auth_register_error", { error: (error as Error)?.message });
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
      // Unexpected login failures flow through the app's error-handling middleware.
      next(error);
    }
  };

  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = parseForgotPasswordBody(req.body);
      const dispatch = await this.authService.prepareForgotPassword(input);

      // SECURITY: identical response whether or not the account exists.
      res.json({ success: true, message: "Password reset link sent successfully" });

      if (dispatch.found) {
        this.emailSender.sendPasswordResetEmail(dispatch.email as string, dispatch.name, dispatch.resetLink as string);
      }
    } catch (error) {
      if (error instanceof AuthHttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      logger.error("auth_forgot_password_error", { error: (error as Error)?.message });
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
      logger.error("auth_reset_password_error", { error: (error as Error)?.message });
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
      logger.error("auth_change_password_error", { error: (error as Error)?.message });
      res.status(500).json({ message: "Server error" });
    }
  };
}
