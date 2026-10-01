import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../src/app/shared/errors/app-error";

describe("http-status-codes constants used by AppError (architecture)", () => {
  it("exposes the expected numeric values", () => {
    assert.equal(StatusCodes.OK, 200);
    assert.equal(StatusCodes.CREATED, 201);
    assert.equal(StatusCodes.NO_CONTENT, 204);
    assert.equal(StatusCodes.BAD_REQUEST, 400);
    assert.equal(StatusCodes.UNAUTHORIZED, 401);
    assert.equal(StatusCodes.FORBIDDEN, 403);
    assert.equal(StatusCodes.NOT_FOUND, 404);
    assert.equal(StatusCodes.CONFLICT, 409);
    assert.equal(StatusCodes.UNPROCESSABLE_ENTITY, 422);
    assert.equal(StatusCodes.TOO_MANY_REQUESTS, 429);
    assert.equal(StatusCodes.INTERNAL_SERVER_ERROR, 500);
    assert.equal(StatusCodes.BAD_GATEWAY, 502);
    assert.equal(StatusCodes.SERVICE_UNAVAILABLE, 503);
  });
});

describe("AppError foundation (architecture)", () => {
  it("carries statusCode/message/errorCode and defaults isOperational to true", () => {
    const err = new AppError(StatusCodes.CONFLICT, "duplicate", "DUPLICATE");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, StatusCodes.CONFLICT);
    assert.equal(err.message, "duplicate");
    assert.equal(err.errorCode, "DUPLICATE");
    assert.equal(err.isOperational, true);
  });

  it("static factories map to the correct status codes", () => {
    assert.equal(AppError.badRequest("x").statusCode, StatusCodes.BAD_REQUEST);
    assert.equal(AppError.unauthorized("x").statusCode, StatusCodes.UNAUTHORIZED);
    assert.equal(AppError.forbidden("x").statusCode, StatusCodes.FORBIDDEN);
    assert.equal(AppError.notFound("x").statusCode, StatusCodes.NOT_FOUND);
    assert.equal(AppError.conflict("x").statusCode, StatusCodes.CONFLICT);
  });
});
