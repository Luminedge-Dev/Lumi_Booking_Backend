// Long-lived-process entrypoint: start the server, register lifecycle
// handlers. No business logic here. Run with: pnpm dev
import { registerProcessHandlers, startServer } from "./server";

export async function main(): Promise<void> {
  const handle = await startServer();
  registerProcessHandlers(handle);
}

// Auto-run only as the entrypoint, never on import.
const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("main.ts") || entrypoint.endsWith("main.js")) {
  main().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
