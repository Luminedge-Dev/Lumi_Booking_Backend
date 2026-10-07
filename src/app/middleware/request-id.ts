import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { runWithRequestId } from "../shared/request-context/request-context";

const REQUEST_ID_HEADER = "x-request-id";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidClientRequestId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_REQUEST_ID_PATTERN.test(value);
}

// Must mount first so x-request-id is set on every response, including CORS/rate-limit rejections.
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const clientProvided = req.headers[REQUEST_ID_HEADER];
  const id = isValidClientRequestId(clientProvided) ? clientProvided : randomUUID();

  res.setHeader(REQUEST_ID_HEADER, id);
  runWithRequestId(id, () => next());
};
