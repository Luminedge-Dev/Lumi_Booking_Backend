import { z } from "zod";
import { ObjectId } from "mongodb";
import type { ParsedProfileEditInput } from "./user.types";

// Validation must run BEFORE authorization so a malformed target yields 400, not 403.

export function isValidUserIdParam(userId: unknown): userId is string {
  return typeof userId === "string" && ObjectId.isValid(userId);
}

const requestProfileEditBodySchema = z.object({
  userId: z.string().refine((value) => ObjectId.isValid(value)),
  // note stays unknown here; the storable check below narrows it to text.
  note: z.unknown().optional(),
});

export function parseRequestProfileEditBody(body: unknown): ParsedProfileEditInput | null {
  const result = requestProfileEditBodySchema.safeParse(body ?? {});
  if (!result.success) return null;
  return { userId: result.data.userId, note: result.data.note || "" };
}

// Stage 15: profile_edit_note is a PostgreSQL text column. Mongo persisted any
// truthy JSON value; anything that is not NUL-free text is now rejected with a
// fixed 400 (intentional, documented difference).
export function isStorableNote(note: unknown): note is string {
  return typeof note === "string" && !note.includes("\u0000");
}
