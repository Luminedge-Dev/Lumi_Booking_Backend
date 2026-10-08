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

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export function parseMockAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < INT4_MIN || n > INT4_MAX) return null;
  return n;
}

export function addInt4(left: number, right: number): number | null {
  const sum = left + right;
  if (!Number.isInteger(sum) || sum < INT4_MIN || sum > INT4_MAX) return null;
  return sum;
}

export function getFutureISODate(duration: unknown): string {
  const [valueStr, unit] = String(duration || "").split(" ");
  const value = parseInt(valueStr, 10);
  if (!value || !unit) return new Date().toISOString();
  const now = new Date();
  switch (unit.toLowerCase()) {
    case "minute":
    case "minutes":
      now.setMinutes(now.getMinutes() + value);
      break;
    case "day":
    case "days":
      now.setDate(now.getDate() + value);
      break;
    case "month":
    case "months":
      now.setMonth(now.getMonth() + value);
      break;
    default:
      return new Date().toISOString();
  }
  return now.toISOString();
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseApproveEmail(value: unknown): { ok: true; email: string } | { ok: false } | { ok: true; omitted: true } {
  if (value === undefined) return { ok: true, omitted: true };
  if (typeof value !== "string" || !EMAIL_FORMAT.test(value)) return { ok: false };
  return { ok: true, email: value };
}
