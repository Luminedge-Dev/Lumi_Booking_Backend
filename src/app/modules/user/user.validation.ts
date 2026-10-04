import { z } from "zod";
import { ObjectId } from "mongodb";
import type { ParsedProfileEditInput } from "./user.types";

// Pure parsers only -- no Express coupling, no throwing. user.route.ts wraps
// these into middleware that writes the exact legacy 400 body on failure
// (ordering requirement: validation must run BEFORE authorization so a
// missing/malformed target produces the legacy 400, not a misleading 403 --
// see Stage 8 plan ss5).

export function isValidUserIdParam(userId: unknown): userId is string {
  return typeof userId === "string" && ObjectId.isValid(userId);
}

const requestProfileEditBodySchema = z.object({
  userId: z.string().refine((value) => ObjectId.isValid(value)),
  // Deliberately unknown (not z.string()): legacy accepts ANY truthy JSON
  // value for note and persists it unchanged (`note || ""`), so requiring a
  // string here would introduce an unrelated Stage 8 validation change.
  note: z.unknown().optional(),
});

// Legacy (routes/user.routes.js:269-291) only checks `!userId ||
// !ObjectId.isValid(userId)`; note follows `note || ""` exactly -- any
// truthy JSON value is persisted unchanged, falsy/missing maps to "".
// Returns null on failure rather than throwing -- the caller (route
// middleware) decides how to respond.
export function parseRequestProfileEditBody(body: unknown): ParsedProfileEditInput | null {
  const result = requestProfileEditBodySchema.safeParse(body ?? {});
  if (!result.success) return null;
  return { userId: result.data.userId, note: result.data.note || "" };
}
