import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { getPrismaClient } from "./prisma";

// Prisma interactive-transaction conflict. Verified against Prisma's error
// reference: P2034 is a write conflict or deadlock and is the retryable class.
// https://www.prisma.io/docs/orm/reference/error-reference#p2034
const TRANSACTION_CONFLICT_CODE = "P2034";

export type TransactionClient = Omit<Prisma.TransactionClient, never>;

// Stage 16 finding (proven live on stage13-dev): the model API reports a
// serialization failure (SQLSTATE 40001) as P2034, but `$queryRaw` /
// `$executeRaw` report the very same failure as P2010 ("Raw query failed")
// with the cause preserved at meta.driverAdapterError.cause. Raw SQL is how
// Stage 16 takes row locks and runs guarded updates, so P2010 is a retryable
// conflict ONLY when that cause says so; every other P2010 is not retried.
const RAW_CONFLICT_CODE = "P2010";
const CONFLICT_SQLSTATES = new Set(["40001", "40P01"]);

function isRawTransactionConflict(error: object): boolean {
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapter !== "object" || adapter === null) return false;
  const cause = (adapter as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  const { kind, originalCode } = cause as { kind?: unknown; originalCode?: unknown };
  return (
    kind === "TransactionWriteConflict" ||
    (typeof originalCode === "string" && CONFLICT_SQLSTATES.has(originalCode))
  );
}

export function isTransactionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === TRANSACTION_CONFLICT_CODE) return true;
  return code === RAW_CONFLICT_CODE && isRawTransactionConflict(error);
}

// Prisma interactive-transaction defaults are maxWait 2000 ms / timeout 5000 ms.
// Callers may raise them within these hard ceilings; omitting them keeps the
// Prisma defaults exactly as before.
export const MAX_TRANSACTION_WAIT_MS = 30000;
export const MAX_TRANSACTION_TIMEOUT_MS = 60000;

type TransactionRunnerOptions = { isolationLevel: "Serializable"; maxWait?: number; timeout?: number };

type TransactionRunner = (
  fn: (tx: TransactionClient) => Promise<unknown>,
  options: TransactionRunnerOptions
) => Promise<unknown>;

export interface SerializableTransactionOptions {
  maxAttempts?: number;
  backoffMs?: number;
  /** Optional ceiling for waiting to START the transaction (ms). Prisma default applies when omitted. */
  maxWaitMs?: number;
  /** Optional ceiling for the transaction body (ms). Prisma default applies when omitted. */
  timeoutMs?: number;
  execute?: TransactionRunner;
}

function assertBoundedMs(name: string, value: number | undefined, ceiling: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`${name} must be an integer between 1 and ${ceiling}`);
  }
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
  assertBoundedMs("maxWaitMs", options.maxWaitMs, MAX_TRANSACTION_WAIT_MS);
  assertBoundedMs("timeoutMs", options.timeoutMs, MAX_TRANSACTION_TIMEOUT_MS);
  const runnerOptions: TransactionRunnerOptions = {
    isolationLevel: "Serializable",
    ...(options.maxWaitMs !== undefined ? { maxWait: options.maxWaitMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  };

  const execute: TransactionRunner =
    options.execute ??
    ((work, args) => getPrismaClient().$transaction(work, args));
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return (await execute(fn, runnerOptions)) as T;
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      lastConflict = error;
      if (backoffMs > 0) {
        // Linear backoff plus jitter: contenders that conflicted together must
        // not retry in lock-step and conflict again.
        const delay = backoffMs * attempt + Math.floor(Math.random() * backoffMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
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
