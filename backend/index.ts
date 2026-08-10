import { app } from "./src/app";
import { bootstrapInitialAdmin } from "./src/lib/bootstrap";
import { refreshTrustedClientIpHeaders } from "./src/lib/client-ip";

const rawPort = process.env.PORT;
const port = rawPort !== undefined && rawPort !== "" ? Number(rawPort) : 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT configuration: "${String(process.env.PORT)}". PORT must be a valid integer between 1 and 65535.`);
}

// The background worker queue is started by src/app.ts (deferred out of
// module evaluation so the TLA module graph fully resolves first). Do NOT
// add a second startWorkerQueue() call here — the worker must have exactly
// one startup location.
await bootstrapInitialAdmin();
await refreshTrustedClientIpHeaders();

app
  .listen({
    port,
    // Reject request bodies larger than the 100 MiB configuration-version
    // upload limit before Elysia buffers them into memory (memory DoS guard).
    maxRequestBodySize: 100 * 1024 * 1024,
  });

console.log(
  `🦊 Backend is running at ${String(app.server?.hostname)}:${String(app.server?.port)}`
);
