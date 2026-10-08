import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { AuthRepository } from "./auth.repository";
import { newObjectIdHex } from "../../shared/utils/object-id";
import type {
  AuthAccountState,
  AuthConfig,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  LoginResult,
  NewUserRecord,
  RegisterInput,
  RegisterResult,
  ResetPasswordInput,
} from "./auth.types";
import { UserEmailConflictError } from "./auth.types";

// Thrown for every locked legacy status/body pair; the controller writes
// res.status(status).json(body) verbatim, never via the shared errorHandler.
export class AuthHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>
  ) {
    super("AuthHttpError");
    this.name = "AuthHttpError";
  }
}

export interface ForgotPasswordDispatch {
  found: boolean;
  email?: string;
  name?: unknown;
  resetLink?: string;
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly config: AuthConfig
  ) {}

  async register(input: RegisterInput): Promise<RegisterResult & { normalizedEmail: string; name: unknown }> {
    const normalizedEmail = input.email.toLowerCase();

    const existingUser = await this.repository.findByEmail(normalizedEmail);
    if (existingUser) {
      throw new AuthHttpError(400, { message: "User already exists" });
    }

    const existingByTransactionId = await this.repository.findByTransactionId(input.transactionId);
    if (existingByTransactionId) {
      throw new AuthHttpError(409, { message: "Transaction ID is already in use." });
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);

    const newUserId = newObjectIdHex();
    const now = new Date();
    const newUser: NewUserRecord = {
      _id: newUserId,
      name: input.name as string,
      email: normalizedEmail,
      contactNo: input.contactNo as string | null | undefined,
      passportNumber: input.passportNumber as string | null | undefined,
      sex: input.sex as string | null | undefined,
      dateOfBirth: input.dateOfBirth as string | null | undefined,
      password: hashedPassword,
      mock: 0,
      totalMock: 0,
      result: (input.result ?? null) as unknown[] | null,
      transactionId: input.transactionId as string | null | undefined,
      role: "user",
      status: "active",
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.repository.insertUser(newUser);
    } catch (error) {
      // The checks above are not atomic; the repository serializes inserts per email.
      if (error instanceof UserEmailConflictError) {
        throw new AuthHttpError(409, { message: "User already exists" });
      }
      throw error;
    }

    return { userId: newUserId, normalizedEmail, name: input.name };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.repository.findByEmail(input.email.toLowerCase());
    if (!user || !(await bcrypt.compare(input.password, user.password))) {
      throw new AuthHttpError(401, { message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { email: user.email, userId: user._id.toString(), role: user.role },
      this.config.jwtSecret,
      { expiresIn: this.config.jwtExpiresIn } as jwt.SignOptions
    );

    const decoded = jwt.decode(token) as { exp?: number } | null;
    const sessionMs =
      decoded && decoded.exp ? decoded.exp * 1000 - Date.now() : 7 * 24 * 60 * 60 * 1000;

    return {
      token,
      sessionMs,
      email: user.email,
      role: user.role,
      userId: user._id.toString(),
    };
  }

  async prepareForgotPassword(input: ForgotPasswordInput): Promise<ForgotPasswordDispatch> {
    const userData = await this.repository.findByEmail(input.email.toLowerCase());
    if (!userData) {
      return { found: false };
    }

    const resetPassToken = jwt.sign(
      { email: userData.email, userId: userData._id.toString() },
      this.config.jwtResetPasswordSecret,
      { expiresIn: this.config.jwtResetPasswordTokenExpiresIn } as jwt.SignOptions
    );

    const resetLink = `${this.config.resetPasswordLink}?userId=${userData._id}&token=${resetPassToken}`;

    return {
      found: true,
      email: userData.email,
      name: (userData as unknown as { name?: unknown }).name,
      resetLink,
    };
  }

  async resetPassword(input: ResetPasswordInput): Promise<void> {
    if (!ObjectId.isValid(String(input.userId))) {
      throw new AuthHttpError(400, { success: false, message: "Invalid user ID" });
    }

    if (input.newPassword.length < 8) {
      throw new AuthHttpError(400, {
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    let decoded: { userId: string | ObjectId; iat?: number };
    try {
      decoded = jwt.verify(input.token, this.config.jwtResetPasswordSecret) as typeof decoded;
    } catch {
      throw new AuthHttpError(400, { success: false, message: "Invalid or expired token!" });
    }

    if (decoded.userId.toString() !== String(input.userId)) {
      throw new AuthHttpError(400, { success: false, message: "Token mismatch!" });
    }

    const userData = await this.repository.findById(input.userId);
    if (!userData) {
      throw new AuthHttpError(404, { success: false, message: "User not found or inactive!" });
    }

    if (userData.passwordChangedAt && decoded.iat) {
      const changedAtSec = Math.floor(new Date(userData.passwordChangedAt).getTime() / 1000);
      if (decoded.iat < changedAtSec) {
        throw new AuthHttpError(400, {
          success: false,
          message: "This reset link has already been used.",
        });
      }
    }

    const hashedPassword = await bcrypt.hash(input.newPassword, 12);
    await this.repository.updatePasswordByUserId(userData._id, hashedPassword, {
      passwordChangedAt: new Date(),
    });
  }

  async changePassword(actorEmail: string | undefined, input: ChangePasswordInput): Promise<void> {
    // Mirrors legacy: a JWT missing the email claim throws, caught as generic 500 "Server error".
    if (input.email.toLowerCase() !== actorEmail!.toLowerCase()) {
      throw new AuthHttpError(403, { message: "Forbidden" });
    }

    if (input.newPassword.length < 8) {
      throw new AuthHttpError(400, { message: "New password must be at least 8 characters" });
    }

    const user = await this.repository.findByEmail(input.email.toLowerCase());
    if (!user) {
      throw new AuthHttpError(404, { message: "User not found" });
    }

    const ok = await bcrypt.compare(input.oldPassword, user.password);
    if (!ok) {
      throw new AuthHttpError(401, { message: "Password incorrect" });
    }

    const hashed = await bcrypt.hash(input.newPassword, 12);
    await this.repository.updatePasswordByUserId(user._id, hashed, {
      needPasswordChange: false,
      passwordChangedAt: new Date(),
    });
  }

  // A missing/invalid userId skips the DB lookup and returns {ok:true}.
  async checkAccountState(decoded: { userId?: string | ObjectId; iat?: number }): Promise<AuthAccountState> {
    const userId = decoded?.userId;
    if (!userId || !ObjectId.isValid(String(userId))) {
      return { ok: true };
    }

    const user = await this.repository.findAccountStateById(String(userId));
    if (!user) {
      return { ok: false, code: "ACCOUNT_NOT_FOUND" };
    }
    if (user.isDeleted === true || String(user.status).toLowerCase() === "blocked") {
      return { ok: false, code: "ACCOUNT_BLOCKED" };
    }

    if (user.passwordChangedAt && decoded.iat) {
      const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
      if (decoded.iat < changedAtSec) {
        return { ok: false, code: "TOKEN_STALE" };
      }
    }

    return { ok: true, role: user.role };
  }
}
