import { z } from "zod";
import { ObjectId } from "mongodb";
import type { ParsedProfileEditInput } from "./user.types";

// Validation must run BEFORE authorization so a malformed target yields 400, not 403.

export function isValidUserIdParam(userId: unknown): userId is string {
  return typeof userId === "string" && ObjectId.isValid(userId);
}

const requestProfileEditBodySchema = z.object({
  userId: z.string().refine((value) => ObjectId.isValid(value)),
  // note stays unknown: legacy persists any truthy JSON value unchanged.
  note: z.unknown().optional(),
});

export function parseRequestProfileEditBody(body: unknown): ParsedProfileEditInput | null {
  const result = requestProfileEditBodySchema.safeParse(body ?? {});
  if (!result.success) return null;
  return { userId: result.data.userId, note: result.data.note || "" };
}
