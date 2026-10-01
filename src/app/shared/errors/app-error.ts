import { StatusCodes } from "http-status-codes";

// Small, framework-agnostic domain error. Not wired into any existing route
// or error-handling middleware yet (app.js's error handler is untouched) —
// this is a primitive for migrated modules to adopt one module at a time.
export class AppError extends Error {
  readonly statusCode: number;
  readonly errorCode?: string;
  readonly isOperational: boolean;

  constructor(
    statusCode: number,
    message: string,
    errorCode?: string,
    isOperational = true
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;

    // Restores the prototype chain under the ES2015 class-extends-Error
    // transpilation gap (safe/no-op on targets where it isn't needed).
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, errorCode?: string): AppError {
    return new AppError(StatusCodes.BAD_REQUEST, message, errorCode);
  }

  static unauthorized(message: string, errorCode?: string): AppError {
    return new AppError(StatusCodes.UNAUTHORIZED, message, errorCode);
  }

  static forbidden(message: string, errorCode?: string): AppError {
    return new AppError(StatusCodes.FORBIDDEN, message, errorCode);
  }

  static notFound(message: string, errorCode?: string): AppError {
    return new AppError(StatusCodes.NOT_FOUND, message, errorCode);
  }

  static conflict(message: string, errorCode?: string): AppError {
    return new AppError(StatusCodes.CONFLICT, message, errorCode);
  }
}
