import { Elysia } from "elysia";
import { authPlugin, countLegacyPlaintextTokens } from "../../auth";
import { db } from "../../db";
import { databaseMetrics } from "../../db";
import { agents } from "../../db/schema";
import { count } from "drizzle-orm";
import { type Settings, getSettings } from "../../lib/settings";
import { appVersion } from "../health";
import type { SamlSettings } from "./helpers";
import { probeLandlockAbi, runSandboxRequired } from "../../lib/sandbox";
import { statfsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ParamCtx } from "./types";
import { envEnabled } from "../../lib/env";
import { currentSamlSettings } from "./helpers";
import { migrateLegacyPlaintextTokens } from "../../auth";
import { TOKEN_FORMAT_VERSION } from "../../lib/token-service";
export const systemRoutes = new Elysia({ name: "admin-system" })
  .use(authPlugin)
  .get("/api/v2/admin/system-info", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const storageDir = process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage");
    let storage: { dir: string; "free-bytes": number | null; "total-bytes": number | null } = { dir: storageDir, "free-bytes": null, "total-bytes": null };
    try {
      const s = statfsSync(storageDir);
      storage = { dir: storageDir, "free-bytes": s.bavail * s.bsize, "total-bytes": s.blocks * s.bsize };
    } catch { /* statfs unavailable (non-POSIX) — leave nulls */ }
    const abi = probeLandlockAbi();
    const [agentRows, saml, oidc, ldap] = await Promise.all([
      db.select({ status: agents.status, n: count() }).from(agents).groupBy(agents.status),
      currentSamlSettings().then((s: SamlSettings): boolean => s.enabled).catch((): boolean => false),
      getSettings("oidc").then((s: Settings): boolean => s.enabled === true).catch((): boolean => false),
      getSettings("ldap").then((s: Settings): boolean => s.enabled === true).catch((): boolean => false),
    ]);
    const sandboxRequired = runSandboxRequired();
    let sandboxReason: string | null = null;
    if (abi < 1) {
      sandboxReason = process.env.TERRENCE_LANDLOCK_RUNNER
        ? "landlock-runner missing or Landlock not enabled in the kernel"
        : "Landlock is not available on this kernel (needs Linux >= 5.13 with CONFIG_SECURITY_LANDLOCK)";
    }
    const workerPoll = Number(process.env.TERRENCE_WORKER_POLL_MS ?? "1500");
    return {
      data: {
        version: appVersion(),
        build: process.env.BUILD_SHA ?? "unknown",
        "uptime-seconds": Math.round(process.uptime()),
        "started-at": new Date(Date.now() - process.uptime() * 1000).toISOString(),
        platform: { os: os.platform(), arch: os.arch(), release: os.release() },
        storage,
        database: await databaseMetrics(),
        worker: {
          enabled: !envEnabled(process.env.TERRENCE_DISABLE_WORKER),
          "drain-mode": envEnabled(process.env.TERRENCE_DISABLE_WORKER),
          "poll-interval-ms": Number.isFinite(workerPoll) && workerPoll > 0 ? workerPoll : 1500,
        },
        sandbox: {
          enabled: sandboxRequired,
          available: abi >= 1,
          abi,
          reason: sandboxReason,
        },
        integrations: {
          "signup-enabled": envEnabled(process.env.TERRENCE_ENABLE_LOCAL_SIGNUP),
          "saml-enabled": saml,
          "oidc-enabled": oidc,
          "ldap-enabled": ldap,
          "github-app-configured": typeof process.env.GITHUB_APP_ID === "string" && process.env.GITHUB_APP_ID !== "",
        },
        agents: {
          total: agentRows.reduce((sum: number, row: { status: string; n: number }): number => sum + row.n, 0),
          "by-status": Object.fromEntries(agentRows.map((row: { status: string; n: number }): [string, number] => [row.status, row.n])),
        },
        "legacy-plaintext-tokens": await countLegacyPlaintextTokens().catch((): number => -1),
      },
      "token-format-version": TOKEN_FORMAT_VERSION,
    };
  })
  .post("/api/v2/admin/migrate-legacy-tokens", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const migrated = await migrateLegacyPlaintextTokens();
    return { data: { migrated, "token-format-version": TOKEN_FORMAT_VERSION } };
  });
