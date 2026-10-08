import { ObjectId } from "mongodb";

// Mongo-origin ids are persisted in PostgreSQL as lowercase 24-char hex text
// (D-032: IDs preserved as strings). Request params may be mixed-case hex, so
// every repository lookup canonicalizes through this one function. Returns
// null for anything that is not a valid ObjectId, never throws.
export function toCanonicalObjectIdHex(value: unknown): string | null {
  if (typeof value !== "string" || !ObjectId.isValid(value)) return null;
  return new ObjectId(value).toHexString();
}

export function newObjectIdHex(): string {
  return new ObjectId().toHexString();
}
