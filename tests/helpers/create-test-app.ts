// Test-only factory around the existing app.js createApp(collections).
//
// Uses fake collections only. Never connects to MongoDB, never reads .env
// credentials, never sends email, never starts cron, never creates indexes.
//
// NOTE: the Express app object is intentionally typed without @types/express
// (adding new @types/* packages is out of scope for Stage 3).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createApp = require("../../app");

// Minimal structural stand-in for the Express application object, shaped as a
// Node request listener so supertest accepts it. Deliberately not importing
// "express" types: @types/express is out of scope for Stage 3.
import type { IncomingMessage, ServerResponse } from "node:http";

export type TestApp = (req: IncomingMessage, res: ServerResponse) => unknown;

export function throwingCollection(name: string): Record<string, never> {
  return new Proxy({} as Record<string, never>, {
    get(_target, prop: string | symbol) {
      if (prop === "then") return undefined;
      throw new Error(
        `Unexpected database access in characterization test (${name}.${String(prop)})`
      );
    },
  });
}

export function stubUsersCollection(
  findOneImpl: (filter: unknown, options?: unknown) => Promise<unknown>
): { findOne: (filter: unknown, options?: unknown) => Promise<unknown> } {
  return { findOne: findOneImpl };
}

export function createTestApp(overrides: Record<string, unknown> = {}): TestApp {
  const collections: Record<string, unknown> = {
    usersCollection: throwingCollection("usersCollection"),
    coursesCollection: throwingCollection("coursesCollection"),
    schedulesCollection: throwingCollection("schedulesCollection"),
    bookingMockCollection: throwingCollection("bookingMockCollection"),
    client: {},
    ...overrides,
  };
  return createApp(collections) as TestApp;
}
