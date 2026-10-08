import { createHash } from "node:crypto";

// Deterministic identity of a teacher_assignments row.
//
// The Stage 14 ETL (scripts/migration/stage14/common.ts `deterministicUuid`)
// loaded every row with
//   uuidv5(STAGE14_NAMESPACE, "teacher_assignment:" + userId + ":" + legacyKey)
// using the RAW map key. Runtime code must not import from scripts/, so the
// algorithm is reproduced here and pinned two ways:
//   - tests/modules/booking/teacher-assignment-id.test.ts (golden vectors +
//     equality with the Stage 14 function), and
//   - tests/postgres/booking-contracts.postgres.ts (all stored rows).
// Because the table has no unique constraint, this id is the concurrency key
// for the upsert: the same (user, booking) always resolves to the same row.
const STAGE14_NAMESPACE = "9b3c2f4a-6d1e-5a77-8c0b-5d14e3a14a14";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

export function deterministicUuidV5(name: string): string {
  const hash = createHash("sha1").update(uuidToBytes(STAGE14_NAMESPACE)).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function teacherAssignmentId(userId: string, legacyKey: string): string {
  return deterministicUuidV5(`teacher_assignment:${userId}:${legacyKey}`);
}
