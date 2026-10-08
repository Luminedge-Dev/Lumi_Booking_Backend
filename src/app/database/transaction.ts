import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { getPrismaClient } from "./prisma";

// Prisma interactive-transaction conflict. Verified against Prisma's error
// reference: P2034 is a write conflict or deadlock and is the retryable class.
// https://www.prisma.io/docs/orm/reference/error-reference#p2034
const TRANSACTION_CONFLICT_CODE = "P2034";

type TransactionClient = Omit<Prisma.TransactionClient, never>;

export function isTransactionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === TRANSACTION_CONFLICT_CODE
  );
}

type TransactionRunner = (
  fn: (tx: TransactionClient) => Promise<unknown>,
  options: { isolationLevel: "Serializable" }
) => Promise<unknown>;

export interface SerializableTransactionOptions {
  maxAttempts?: number;
  backoffMs?: number;
  execute?: TransactionRunner;
}

export async function runSerializableTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>,
  options: SerializableTransactionOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 20;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  const execute: TransactionRunner =
    options.execute ??
    ((work, args) => getPrismaClient().$transaction(work, args));
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return (await execute(fn, { isolationLevel: "Serializable" })) as T;
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      lastConflict = error;
      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
  }
  throw lastConflict;
}

// Bounded read: SET LOCAL scopes statement_timeout to one short transaction
// (PostgreSQL equivalent of Mongo maxTimeMS). A fired timeout surfaces as
// SQLSTATE 57014, which runPersistence translates to a TIMEOUT PersistenceError.
export async function runWithStatementTimeout<T>(
  client: PrismaClient,
  timeoutMs: number,
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new Error("timeoutMs must be an integer between 1 and 600000");
  }
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return fn(tx);
    },
    { timeout: timeoutMs + 5000 }
  );
}
