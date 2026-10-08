import { Prisma } from "../../generated/prisma/client.js";
import { measureDatabaseOperation } from "./query-timing";

// Prisma/driver errors stop at the repository boundary. Anything that crosses
// it is a PersistenceError whose message never carries SQL text, constraint
// names, connection details, or Prisma class names.

export type PersistenceErrorKind = "TIMEOUT" | "UNAVAILABLE" | "UNEXPECTED";

export class PersistenceError extends Error {
  constructor(
    readonly kind: PersistenceErrorKind,
    readonly operation: string,
    readonly prismaCode?: string
  ) {
    super(
      `Persistence failure (${kind}) during ${operation}${prismaCode ? ` [${prismaCode}]` : ""}`
    );
    this.name = "PersistenceError";
    Object.setPrototypeOf(this, PersistenceError.prototype);
  }
}

// PostgreSQL SQLSTATE 57014 = query_canceled (statement_timeout fires this).
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

function collectErrorText(error: unknown, depth = 0): string[] {
  if (depth > 4 || typeof error !== "object" || error === null) return [];
  const e = error as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
  const parts: string[] = [];
  if (typeof e.code === "string") parts.push(e.code);
  if (typeof e.message === "string") parts.push(e.message);
  if (e.meta !== undefined) {
    try {
      parts.push(JSON.stringify(e.meta));
    } catch {
      // ignore unserializable meta
    }
  }
  parts.push(...collectErrorText(e.cause, depth + 1));
  return parts;
}

export function isStatementTimeout(error: unknown): boolean {
  return collectErrorText(error).some(
    (text) => text.includes(STATEMENT_TIMEOUT_SQLSTATE) || /statement timeout|canceling statement/i.test(text)
  );
}

function isPrismaOrDriverError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return true;
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return true;
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientValidationError) return true;
  if (error instanceof Prisma.PrismaClientRustPanicError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && (name.startsWith("PrismaClient") || name === "DriverAdapterError");
}

// Errors that are not Prisma/driver errors (domain errors, programming errors,
// missing configuration) pass through untouched.
export function translatePersistenceError(error: unknown, operation: string): unknown {
  if (error instanceof PersistenceError) return error;
  if (!isPrismaOrDriverError(error)) return error;
  const prismaCode = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
  if (isStatementTimeout(error)) return new PersistenceError("TIMEOUT", operation, prismaCode);
  if (error instanceof Prisma.PrismaClientInitializationError || prismaCode === "P1001" || prismaCode === "P1002" || prismaCode === "P1017") {
    return new PersistenceError("UNAVAILABLE", operation, prismaCode);
  }
  return new PersistenceError("UNEXPECTED", operation, prismaCode);
}

export interface PersistenceMeta {
  table: string;
  operation: string;
}

// Single wrapper every Prisma repository call goes through: slow-operation
// timing (Stage 5.5) plus Prisma-error containment.
export async function runPersistence<T>(meta: PersistenceMeta, fn: () => Promise<T>): Promise<T> {
  try {
    return await measureDatabaseOperation({ collection: meta.table, operation: meta.operation }, fn);
  } catch (error) {
    throw translatePersistenceError(error, meta.operation);
  }
}
