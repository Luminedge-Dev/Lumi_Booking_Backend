import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { AuthRepository } from "./auth.repository";
import type {
  AuthAccountState,
  AuthConfig,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  LoginResult,
  RegisterInput,
  RegisterResult,
  ResetPasswordInput,
} from "./auth.types";

// Thrown by service methods for every locked legacy status/body pair.
// auth.controller.ts catches this and writes res.status(status).json(body)
// verbatim -- never routed through the shared AppError/errorHandler path
// (that serializer drops non-"message" fields; several legacy Auth bodies
// use other shapes like {success, message}).
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

// Business orchestration only -- no Express req/res (AGENTS.md layer rules).
// Password hashing, JWT creation/verification, and account-state evaluation
// all live here; HTTP status/body mapping and email-dispatch *timing*
// (fire-and-forget ordering relative to the HTTP response) are the
// controller's job, since that ordering is an HTTP-boundary concern.
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

    const newUserId = new ObjectId();
    const newUser = {
      _id: newUserId,
      name: input.name,
      email: normalizedEmail,
      contactNo: input.contactNo,
      passportNumber: input.passportNumber,
      sex: input.sex,
      dateOfBirth: input.dateOfBirth,
      password: hashedPassword,
      mock: 0,
      totalMock: 0,
      result: input.result,
      transactionId: input.transactionId,
      role: "user",
      status: "active",
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await this.repository.insertUser(newUser);
    } catch (error) {
      // The existence checks above are not atomic -- two concurrent
      // registrations with the same email can both pass them. The unique
      // {email} index is the real guard: a duplicate insert throws E11000.
      if ((error as { code?: number })?.code === 11000) {
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

  // DB lookup + reset-link construction only -- no email send here. The
  // controller sends the generic HTTP response first, then fires the email
  // separately, matching auth.routes.js:207-225's exact ordering
  // (res.json(...) before waitUntil(...)).
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
    // Intentional non-null assertion, NOT a defensive guard: legacy
    // auth.routes.js:297 calls req.user.email.toLowerCase() with no
    // existence check, inside the route's outer try/catch. A validly-signed
    // JWT missing the email claim throws a TypeError there, caught by that
    // catch block, producing the generic 500 "Server error". This mirrors
    // that exact behavior rather than adding new upstream validation --
    // see the plan's dedicated characterization test for this edge case.
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

  // Mirrors middleware/auth.js's checkAccountState() exactly, including its
  // skip-path: a missing/invalid userId returns {ok:true} WITHOUT querying
  // the database at all (not an error -- see auth.types.ts's AuthActor
  // comment). Legacy also short-circuits to {ok:true} when its module-level
  // usersCollection was never initialized via initAuth(); that branch models
  // an optional-wiring footgun specific to the legacy singleton pattern and
  // has no equivalent here, since this module always constructs a repository.
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
