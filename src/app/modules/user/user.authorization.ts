import { ObjectId } from "mongodb";
import type { AuthActor } from "./user.types";

// Pure policy only -- no I/O, no Express/HTTP coupling, never throws. The
// route-level authorization-adapter middleware (user.route.ts) turns a
// `false` result into the exact 403 {message:"Forbidden"} response; this
// file never writes a response itself. Not a generic RoleGuard/permission
// engine -- narrow, named predicates per AGENTS.md's module-first rules.

const STAFF_ROLES = ["admin", "bdm", "teacher"];

function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && ObjectId.isValid(value);
}

// Canonical ObjectId equality, not raw string equality -- a client-supplied
// URL/body id could be upper/mixed-case hex for the same identity, which
// `===` would wrongly treat as a different user.
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

// Stage 8's deliberate tightening (plan ss2): a validly-signed JWT with no
// usable userId claim cannot pass object authorization on these four
// routes, regardless of role. Does NOT apply to /users/with-profile-request
// (plain verifyAdmin, no target comparison -- see user.route.ts).
export function canAccessUserStatus(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && (isSelf(actor, targetUserId) || isStaff(actor));
}

export function canAccessUserSummary(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && (isSelf(actor, targetUserId) || isStaff(actor));
}

// Self-only even for staff -- confirmed no staff caller exists for /profile
// (Stage 8 plan's frontend audit).
export function canAccessProfile(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && isSelf(actor, targetUserId);
}

// Self-only -- the target here is the request body's userId, not a route
// param; the route layer passes it in as targetUserId.
export function canRequestProfileEdit(actor: AuthActor, targetUserId: string): boolean {
  return hasUsableActorId(actor) && isSelf(actor, targetUserId);
}
