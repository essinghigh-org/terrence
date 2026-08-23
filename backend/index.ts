import { app, systemApiApp } from "./src/app";
import { countLegacyPlaintextTokens, migrateLegacyPlaintextTokens } from "./src/auth";
import { bootstrapInitialAdmin } from "./src/lib/bootstrap";
import { refreshTrustedClientIpHeaders } from "./src/lib/client-ip";
import { applyPgMigrations, isPostgres } from "./src/db";
import { log } from "./src/lib/log";
import { reconcileInterruptedLocalRuns, stopWorkerQueue, waitForWorkerDrain } from "./src/worker";
import { markControlPlaneNodeDraining, startControlPlaneHeartbeat } from "./src/routes/health";

const rawPort = process.env.PORT;
const port = rawPort !== undefined && rawPort !== "" ? Number(rawPort) : 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT configuration: "${String(process.env.PORT)}". PORT must be a valid integer between 1 and 65535.`);
}
const rawSystemPort = process.env.SYSTEM_API_PORT ?? process.env.ADMIN_PORT;
const systemPort = rawSystemPort !== undefined && rawSystemPort !== "" ? Number(rawSystemPort) : 8443;
if (!Number.isInteger(systemPort) || systemPort < 1 || systemPort > 65535) {
  throw new Error(`Invalid SYSTEM_API_PORT configuration: "${String(rawSystemPort)}". SYSTEM_API_PORT must be a valid integer between 1 and 65535.`);
}
const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};
const systemHost = readEnv("SYSTEM_API_HOST") ?? "127.0.0.1";
const systemTlsCertPath = readEnv("SYSTEM_API_TLS_CERT");
const systemTlsKeyPath = readEnv("SYSTEM_API_TLS_KEY");
const systemIsRemote = !["127.0.0.1", "::1", "localhost"].includes(systemHost);
if ((systemTlsCertPath === undefined) !== (systemTlsKeyPath === undefined)) {
  throw new Error("SYSTEM_API_TLS_CERT and SYSTEM_API_TLS_KEY must be configured together.");
}
if (systemIsRemote && (systemTlsCertPath === undefined || systemTlsKeyPath === undefined)) {
  throw new Error("SYSTEM_API_HOST is remote; configure SYSTEM_API_TLS_CERT and SYSTEM_API_TLS_KEY before exposing the System API.");
}
const systemTls = systemTlsCertPath !== undefined && systemTlsKeyPath !== undefined
  ? {
      cert: Bun.file(systemTlsCertPath),
      key: Bun.file(systemTlsKeyPath),
    }
  : undefined;
if (systemTls !== undefined && (!(await systemTls.cert.exists()) || !(await systemTls.key.exists()) || systemTls.cert.size === 0 || systemTls.key.size === 0)) {
  throw new Error("SYSTEM_API_TLS_CERT and SYSTEM_API_TLS_KEY must point to non-empty files.");
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
const legacyTokenCount = await countLegacyPlaintextTokens();
if (legacyTokenCount > 0) {
  if (process.env.TERRENCE_ALLOW_LEGACY_TOKENS === "1") {
    const migrated = await migrateLegacyPlaintextTokens();
    log.warn(`[terrence] Migrated ${migrated} legacy plaintext API token(s) to SHA-256 hashes. Remove TERRENCE_ALLOW_LEGACY_TOKENS after this upgrade.`);
  } else {
    log.warn(`[terrence] Found ${legacyTokenCount} legacy plaintext API token(s). Set TERRENCE_ALLOW_LEGACY_TOKENS=1 for one startup to migrate them, then unset it.`);
  }
}
startControlPlaneHeartbeat();

// Startup reconciliation: local runs interrupted by a previous crash or
// restart (SIGKILL, power loss) keep transient statuses that block their
// workspace queues forever. Pre-execution states are requeued; anything that
// may have had side effects (planning, applying) is errored and never
// replayed. Agent-mode runs are left to recoverStaleAgentJobs.
try {
  const reconciled = await reconcileInterruptedLocalRuns();
  if (reconciled.requeued > 0 || reconciled.errored > 0 || reconciled.assessmentsErrored > 0) {
    console.log(
      `[terrence] Startup reconciliation: ${reconciled.requeued} run(s) requeued, `
      + `${reconciled.errored} run(s) errored, ${reconciled.assessmentsErrored} assessment(s) errored`,
    );
  }
} catch (error: unknown) {
  // A DB hiccup at boot must not take the whole instance down; the next
  // restart reconciles again (the pass is idempotent).
  console.error("[terrence] Startup reconciliation failed; runs from before the restart may still be blocked", error);
}

app
  .listen({
    port,
    // Reject request bodies larger than the 100 MiB configuration-version
    // upload limit before Elysia buffers them into memory (memory DoS guard).
    maxRequestBodySize: 100 * 1024 * 1024,
  });
systemApiApp.listen({
  // The System API is an administrative surface (node inventory, diagnostics,
  // support-bundle downloads). Bind it to loopback by default so it is not
  // reachable from other hosts on the same network; override with
  // SYSTEM_API_HOST when a remote agent pool needs to call it directly.
  hostname: systemHost,
  port: systemPort,
  maxRequestBodySize: 100 * 1024 * 1024,
  ...(systemTls === undefined ? {} : { tls: systemTls }),
});

console.log(
  `🦊 Backend is running at ${String(app.server?.hostname)}:${String(app.server?.port)}`
);
console.log(
  `[terrence] System API is running at ${String(systemApiApp.server?.hostname)}:${String(systemApiApp.server?.port)}${systemTls === undefined ? " (HTTP loopback)" : " (TLS)"}`
);

if (isPostgres) {
  // PostgreSQL makes a multi-replica deployment look plausible (shared DB),
  // but the event bus, the worker queue, and the run sandbox are all
  // in-process. Warn loudly so nobody mistakes Postgres for HA.
  console.warn(
    "[terrence] Multiple control-plane replicas are not currently supported. "
    + "Run exactly one Terrence control-plane instance; remote agent pools may be scaled independently.",
  );
}

// Graceful shutdown: Docker/systemd send SIGTERM; a WAL checkpoint here
// means the main DB file is complete the moment the process exits, so a
// backup taken right after stop never misses -wal tail pages (kanban 4.17).
// Order matters: stop claiming NEW work first (drain flag), stop HTTP, wait
// for in-flight local executions up to a bounded grace, then checkpoint.
import { checkpointWal } from "./src/db";

async function shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  console.log(`[terrence] ${signal} received; draining worker, stopping server, checkpointing WAL before shutdown`);
  stopWorkerQueue();
  // Bound the draining write: markControlPlaneNodeDraining performs a DB
  // write with no deadline. If the database is unreachable or slow at
  // shutdown, awaiting it here would stall before the worker drain and the
  // WAL checkpoint. Fail the write (after logging) but never block shutdown.
  await Promise.race([
    markControlPlaneNodeDraining().catch((error: unknown): void => {
      console.warn("[terrence] Failed to mark control-plane node draining", error);
    }),
    new Promise<void>((resolve): void => { setTimeout(resolve, 2_000); }),
  ]);
  let checkpointFailed = false;
  try {
    const drainGraceMs = ((): number => {
      const raw = process.env.TERRENCE_DRAIN_GRACE_MS;
      if (raw === undefined || raw === "") return 6000;
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 25_000) : 6000;
    })();
    const drain = waitForWorkerDrain(drainGraceMs);
    const server = app.server;
    const systemServer = systemApiApp.server;
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
    if (systemServer !== null && systemServer !== undefined) await systemServer.stop(true);
    // Wait for local Terraform/OpenTofu executions to finish so the
    // checkpoint cannot race a run writing its result. On timeout the
    // process exits anyway; startup reconciliation repairs the aftermath.
    const drained = await drain;
    if (!drained) {
      console.warn("[terrence] Worker drain deadline exceeded; in-flight executions will be terminated by exit");
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
