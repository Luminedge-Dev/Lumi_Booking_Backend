import { ObjectId } from "mongodb";
import type { AuthActor } from "../auth/auth.types";

const STAFF_ROLES = ["admin", "bdm", "teacher"];

function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && ObjectId.isValid(value);
}

function isSameId(a: string, b: string): boolean {
  return new ObjectId(a).equals(new ObjectId(b));
}

function hasUsableActorId(actor: AuthActor): actor is AuthActor & { userId: string } {
  return isValidObjectId(actor.userId);
}

export function isSelf(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && isValidObjectId(targetUserId) && isSameId(actor.userId, targetUserId);
}

export function isStaff(actor: AuthActor): boolean {
  return typeof actor.role === "string" && STAFF_ROLES.includes(actor.role);
}

// Self-or-staff only; no ObjectId format check on the target (unknown ids read as empty).
export function canAccessUserSchedules(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && (isSelf(actor, targetUserId) || isStaff(actor));
}
