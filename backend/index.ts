import { app } from "./src/app";
import { bootstrapInitialAdmin } from "./src/lib/bootstrap";
import { refreshTrustedClientIpHeaders } from "./src/lib/client-ip";
import { applyPgMigrations, isPostgres } from "./src/db";

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
// PostgreSQL schema migrations are async (the sqlite migrator runs
// synchronously at module load inside src/db). Fresh postgres databases
// must be migrated before the server accepts traffic.
if (isPostgres) {
  await applyPgMigrations();
}

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

// Graceful shutdown: Docker/systemd send SIGTERM; a WAL checkpoint here
// means the main DB file is complete the moment the process exits, so a
// backup taken right after stop never misses -wal tail pages (kanban 4.17).
import { checkpointWal } from "./src/db";

async function shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  console.log(`[terrence] ${signal} received; stopping server and checkpointing WAL before shutdown`);
  let checkpointFailed = false;
  try {
    const server = app.server;
    if (server !== null && server !== undefined) {
      // Stop accepting new connections and wait for in-flight handlers so the
      // checkpoint below sees a quiesced database. Bound the wait: if the
      // graceful stop has not completed within the deadline, force-close.
      const graceful = server.stop(false);
      const deadline = new Promise<"timeout">((resolve): void => {
        setTimeout((): void => resolve("timeout"), 5000);
      });
      const outcome = await Promise.race([
        graceful.then((): "drained" => "drained"),
        deadline,
      ]);
      if (outcome === "timeout") {
        console.warn("[terrence] Graceful stop timed out; forcing connection close");
        await server.stop(true);
      }
    }
    checkpointWal();
  } catch (error: unknown) {
    checkpointFailed = true;
    console.error("[terrence] WAL checkpoint failed", error);
  }
  // A failed checkpoint means the main DB file may miss recent writes; exit
  // non-zero so supervisors (systemd restart policies, Docker HEALTHCHECK)
  // can react instead of treating a flaky shutdown as success.
  process.exit(checkpointFailed ? 1 : 0);
}
process.on("SIGTERM", (): void => { void shutdown("SIGTERM"); });
process.on("SIGINT", (): void => { void shutdown("SIGINT"); });
