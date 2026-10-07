import { ObjectId } from "mongodb";
import type { AuthActor } from "./user.types";

const STAFF_ROLES = ["admin", "bdm", "teacher"];

function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && ObjectId.isValid(value);
}

// Canonical ObjectId equality: mixed-case hex for the same id must compare equal.
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

// A JWT with no usable userId claim passes no object authorization, regardless of role.
export function canAccessUserStatus(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && (isSelf(actor, targetUserId) || isStaff(actor));
}

export function canAccessUserSummary(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && (isSelf(actor, targetUserId) || isStaff(actor));
}

// Self-only, even for staff.
export function canAccessProfile(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && isSelf(actor, targetUserId);
}

export function canRequestProfileEdit(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && isSelf(actor, targetUserId);
}
