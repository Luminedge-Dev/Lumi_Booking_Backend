// Serverless entrypoint (Vercel): dispatch the request through the shared
// runtime. No port listening, no cron, no domain logic here.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Application } from "express";
import { getRuntimeInstance, resetRuntimeInstance } from "./app/runtime/bootstrap";

type RequestListener = (req: IncomingMessage, res: ServerResponse) => unknown;

async function handler(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    // Reuse the initialized runtime across warm serverless requests.
    const runtime = await getRuntimeInstance();
    await runtime.ensureHealthy();
    return (runtime.app as unknown as Application as unknown as RequestListener)(req, res);
  } catch (err) {
    console.error("Failed to initialize app:", err);
    resetRuntimeInstance(); // allow a retry on the next request
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Server initialization failed." }));
    return undefined;
  }
}

// Default export for @vercel/node, named export for unit tests.
export default handler;
export { handler };
