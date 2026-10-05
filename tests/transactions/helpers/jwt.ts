import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";

// Test-only JWT/SMTP environment setup, applied/restored explicitly by the
// suite's before()/after() hooks (see transaction-foundation.transaction.ts)
// rather than as a bare module-load-time side effect -- Stage 10 is test
// INFRASTRUCTURE and must leave process.env exactly as it found it.
const ENV_KEYS = ["JWT_SECRET", "JWT_RESET_PASS_SECRET", "SMTP_HOST", "EMAIL", "APP_PASS"] as const;
const envSnapshot = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

export function applyTestEnv(): void {
  process.env.JWT_SECRET = "test-only-secret";
  process.env.JWT_RESET_PASS_SECRET = "test-only-reset-secret";
  delete process.env.SMTP_HOST;
  delete process.env.EMAIL;
  delete process.env.APP_PASS;
}

export function restoreTestEnv(): void {
  for (const [key, original] of envSnapshot) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

export function signTestToken(userId: ObjectId, role = "user"): string {
  return jwt.sign({ userId: userId.toString(), email: "actor@example.test", role }, "test-only-secret");
}

// verifyToken reloads the user fresh from the real usersCollection by _id on
// every request (middleware/auth.js's checkAccountState) -- a bare signed
// token with no matching user document will 401. Default email is a
// deterministic, auto-incrementing sequence (not a fixed placeholder)
// because getIndexOps() applies the real users.email unique index to this
// same ephemeral database, and several Stage 10 cases need multiple real,
// simultaneously-existing user documents in one test (last-seat race's two
// users, cancellation's actor vs. admin, teacher-assignment's booking
// owner) -- a fixed placeholder would collide on the second seedUser() call.
let userCounter = 0;

export interface SeedUserOverrides {
  email?: string;
  role?: string;
  mock?: number;
  isDeleted?: boolean;
  status?: string;
}

export async function seedUser(usersCollection: Collection<Document>, overrides: SeedUserOverrides = {}) {
  userCounter += 1;
  const doc = {
    _id: new ObjectId(),
    email: `tx-user-${userCounter}@example.test`,
    password: "x",
    role: "user",
    mock: 1,
    isDeleted: false,
    status: "active",
    ...overrides,
  };
  await usersCollection.insertOne(doc);
  return doc;
}
