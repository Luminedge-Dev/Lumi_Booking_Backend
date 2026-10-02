import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { runWithRequestId } from "../shared/request-context/request-context";

const REQUEST_ID_HEADER = "x-request-id";

// Conservative accepted format: 1-128 chars of a known-safe character set.
// Rejects whitespace-only values, comma/joined duplicate-header values,
// and anything containing characters that could be unsafe to echo back
// verbatim in a response header. A bad/duplicate/malformed incoming ID is
// never a 400 — it's silently replaced with a generated UUID.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidClientRequestId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_REQUEST_ID_PATTERN.test(value);
}

// Must mount before everything else (even helmet) so x-request-id is on every
// response, including CORS rejections and rate-limit 429s. Downstream code —
// including error-handler.ts, whose 4-param signature is frozen — reads the
// active ID via getRequestId() rather than a new parameter, because Express
// 4's synchronous middleware/error-propagation chain stays inside the
// AsyncLocalStorage context established by runWithRequestId below. Note:
// req.headers["x-request-id"] can already be a joined/comma-separated string
// for a duplicate header depending on Node's HTTP parsing, not necessarily a
// string[] — the regex above rejects a joined value outright (commas aren't
// in the allowed character set) rather than assuming array representation.
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const clientProvided = req.headers[REQUEST_ID_HEADER];
  const id = isValidClientRequestId(clientProvided) ? clientProvided : randomUUID();

  res.setHeader(REQUEST_ID_HEADER, id);
  runWithRequestId(id, () => next());
};
