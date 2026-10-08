import type { ObjectId } from "mongodb";

// Deliberately permissive: only a valid JWT signature is required.
// Consumers that need a field check for it themselves.
export interface AuthActor {
  userId?: string;
  email?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

export interface AuthTokenPayload {
  email: string;
  userId: string | ObjectId;
  role: string;
}

export interface AuthAccountStateOk {
  ok: true;
  role?: string;
}

export type AuthAccountStateCode =
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_BLOCKED"
  | "TOKEN_STALE";

export interface AuthAccountStateFail {
  ok: false;
  code: AuthAccountStateCode;
}

export type AuthAccountState = AuthAccountStateOk | AuthAccountStateFail;

export interface AuthUserRecord {
  _id: string;
  name?: string;
  email: string;
  password: string;
  role: string;
  status?: string;
  isDeleted?: boolean;
  passwordChangedAt?: Date | string;
  needPasswordChange?: boolean;
}

// A registration that is already proven storable in PostgreSQL (see
// parseRegisterBody). The server owns role/status/isDeleted/mock counters.
export interface NewUserRecord {
  _id: string;
  name: string;
  email: string;
  contactNo?: string | null;
  passportNumber?: string | null;
  sex?: string | null;
  dateOfBirth?: string | null;
  password: string;
  mock: 0;
  totalMock: 0;
  result: unknown[] | null;
  transactionId?: string | null;
  role: "user";
  status: "active";
  isDeleted: false;
  createdAt: Date;
  updatedAt: Date;
}

// Thrown by the repository when a user with exactly this email already exists
// (PostgreSQL has no UNIQUE(email); the repository serializes inserts per
// email instead). The service maps it to the legacy 409.
export class UserEmailConflictError extends Error {
  constructor() {
    super("User email already exists");
    this.name = "UserEmailConflictError";
  }
}

export interface PasswordUpdateExtra {
  passwordChangedAt?: Date;
  needPasswordChange?: boolean;
}

export type AuthAccountStateProjection = Pick<
  AuthUserRecord,
  "isDeleted" | "status" | "role" | "passwordChangedAt"
>;

export interface RegisterInput {
  name?: unknown;
  email: string;
  password: string;
  contactNo?: unknown;
  result?: unknown;
  passportNumber?: unknown;
  transactionId?: unknown;
  sex?: unknown;
  dateOfBirth?: unknown;
}

export interface RegisterResult {
  userId: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  sessionMs: number;
  email: string;
  role: string;
  userId: string;
}

export interface ForgotPasswordInput {
  email: string;
}

export interface ResetPasswordInput {
  userId: string;
  token: string;
  newPassword: string;
}

export interface ChangePasswordInput {
  email: string;
  oldPassword: string;
  newPassword: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtResetPasswordSecret: string;
  jwtExpiresIn: string;
  jwtResetPasswordTokenExpiresIn: string;
  resetPasswordLink: string | undefined;
  isProduction: boolean;
}

export interface AuthEmailSender {
  sendWelcomeEmail(email: string, name: unknown): void;
  sendPasswordResetEmail(email: string, name: unknown, resetLink: string): void;
}
