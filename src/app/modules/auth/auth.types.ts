import type { ObjectId } from "mongodb";

// Deliberately permissive: unless characterization proves legacy verifyToken
// rejects a token missing email/role/userId, this type must not assert they
// exist. middleware/auth.js's checkAccountState() returns {ok:true} (skipping
// the live-account lookup entirely) when decoded.userId is missing/invalid,
// and verifyToken never validates decoded.email/decoded.role at all -- only
// a valid JWT signature is required. Consumers that need a field (verifyAdmin/
// verifyStaff need role; change-password needs email) check for it themselves.
export interface AuthActor {
  userId?: string;
  email?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

// The exact shape routes/auth.routes.js's login handler signs, and the same
// shape scripts/mint-service-token.js mints for server-to-server staff
// credentials -- the native middleware must keep accepting this unchanged.
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

// Auth's own minimal persistence projection -- intentionally NOT the full
// Stage 6 canonical User model (context/database-canonical-models.md). Stage 8
// owns the full User repository; this module only ever needs these fields.
export interface AuthUserRecord {
  _id: ObjectId;
  email: string;
  password: string;
  role: string;
  status?: string;
  isDeleted?: boolean;
  passwordChangedAt?: Date | string;
  needPasswordChange?: boolean;
}

// Projection used by checkAccountState-equivalent live reloads -- mirrors
// middleware/auth.js's explicit `projection: { isDeleted, status, role,
// passwordChangedAt }`.
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
  userId: ObjectId;
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

// Subset of AppConfig (src/app/config/env.ts) this module actually needs --
// passed in explicitly (single configuration owner, AGENTS.md ss4a rule 5),
// never read from process.env inside this module.
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
