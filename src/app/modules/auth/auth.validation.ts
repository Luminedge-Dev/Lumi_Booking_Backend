import { z } from "zod";
import { AuthHttpError } from "./auth.service";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from "./auth.types";

// Thin, Auth-owned validation adapter (per the plan's ss7) -- NOT the shared
// src/app/middleware/validate-request.ts, which always emits a fixed
// {message:"Invalid request", code:"VALIDATION_ERROR"} shape on failure.
// That shape matches none of the exact legacy Auth messages below, so using
// it here would be an API-compatibility regression. Zod still does the real
// type/presence checking; a failed parse is mapped to the single legacy
// message those checks already produced.
const emailPasswordSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

export function parseLoginBody(body: unknown): LoginInput {
  const result = emailPasswordSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new AuthHttpError(400, { message: "Email and password are required" });
  }
  return result.data;
}

// passthrough(): registration's non-auth profile fields (name, contactNo,
// etc.) stay compatibility-permissive -- only email/password are
// Auth-relevant and get strict validation (AGENTS.md: don't impose new
// profile rules that belong to the future Stage 8 User migration).
const registerSchema = z
  .object({
    email: z.string().min(1),
    password: z.string().min(1),
  })
  .passthrough();

export function parseRegisterBody(body: unknown): RegisterInput {
  const result = registerSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new AuthHttpError(400, { message: "Email and password are required" });
  }
  if (result.data.password.length < 8) {
    throw new AuthHttpError(400, { message: "Password must be at least 8 characters" });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  // SECURITY: role/status/isDeleted/mock/totalMock are never read from the
  // request body here, matching auth.routes.js's own explicit comment --
  // those are server-owned (set in auth.service.ts#register).
  return {
    email: result.data.email,
    password: result.data.password,
    name: raw.name,
    contactNo: raw.contactNo,
    result: raw.result,
    passportNumber: raw.passportNumber,
    transactionId: raw.transactionId,
    sex: raw.sex,
    dateOfBirth: raw.dateOfBirth,
  };
}

const forgotPasswordSchema = z.object({ email: z.string().min(1) });

export function parseForgotPasswordBody(body: unknown): ForgotPasswordInput {
  const result = forgotPasswordSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new AuthHttpError(400, { success: false, message: "Email is required" });
  }
  return result.data;
}

// NOT a zod schema: legacy reset-password only checks truthiness for
// userId/token (no typeof constraint on either -- auth.routes.js:236), and a
// strict typeof==="string" check for newPassword only. A zod z.string()
// would reject a non-string userId/token differently than legacy's plain
// truthy check, narrowing accepted input beyond what currently works.
export function parseResetPasswordBody(body: unknown): ResetPasswordInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const { userId, token, newPassword } = raw;
  if (!userId || !token || typeof newPassword !== "string" || !newPassword) {
    throw new AuthHttpError(400, { success: false, message: "All fields are required" });
  }
  return { userId: String(userId), token: String(token), newPassword };
}

const changePasswordSchema = z.object({
  email: z.string().min(1),
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export function parseChangePasswordBody(body: unknown): ChangePasswordInput {
  const result = changePasswordSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new AuthHttpError(400, { message: "Email, oldPassword, newPassword are required" });
  }
  return result.data;
}
