import { z } from "zod";
import { AuthHttpError } from "./auth.service";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from "./auth.types";

// Not the shared validator: its fixed shape matches none of the legacy Auth messages below.
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

const registerSchema = z
  .object({
    email: z.string().min(1),
    password: z.string().min(1),
  })
  .passthrough();

// Stage 15: PostgreSQL columns are typed (name NOT NULL text, optional text
// columns, JSON array result, no NUL). Mongo persisted any BSON value; a body
// that cannot be stored is rejected up front with one fixed 400 that never
// echoes the offending value. Documented intentional difference.
const REGISTRATION_TEXT_FIELDS = ["name", "contactNo", "passportNumber", "sex", "dateOfBirth", "transactionId"] as const;

function isNulFreeText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000");
}

function assertStorableRegistration(email: string, raw: Record<string, unknown>): void {
  const invalid = (): never => {
    throw new AuthHttpError(400, { message: "Invalid registration data" });
  };
  if (!isNulFreeText(email)) invalid();
  for (const field of REGISTRATION_TEXT_FIELDS) {
    const value = raw[field];
    if (value !== undefined && value !== null && !isNulFreeText(value)) invalid();
  }
  const result = raw.result;
  if (result !== undefined && result !== null) {
    if (!Array.isArray(result)) invalid();
    try {
      if (JSON.stringify(result).includes("\\u0000")) invalid();
    } catch {
      invalid();
    }
  }
}

export function parseRegisterBody(body: unknown): RegisterInput {
  const result = registerSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new AuthHttpError(400, { message: "Email and password are required" });
  }
  if (result.data.password.length < 8) {
    throw new AuthHttpError(400, { message: "Password must be at least 8 characters" });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  assertStorableRegistration(result.data.email, raw);
  // SECURITY: role/status/isDeleted/mock/totalMock are server-owned, never read from the body.
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

// Legacy checks truthiness only for userId/token; a zod string check would narrow accepted input.
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
