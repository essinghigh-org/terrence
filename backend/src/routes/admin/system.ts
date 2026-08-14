import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
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
import { currentSamlSettings } from "./helpers";
export const systemRoutes = new Elysia({ name: "admin-system" })
  .use(authPlugin)
  .get("/api/v2/admin/system-info", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
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
          enabled: process.env.TERRENCE_DISABLE_WORKER !== "1",
          "drain-mode": process.env.TERRENCE_DISABLE_WORKER === "1",
          "poll-interval-ms": Number.isFinite(workerPoll) && workerPoll > 0 ? workerPoll : 1500,
        },
        sandbox: {
          enabled: sandboxRequired,
          available: abi >= 1,
          abi,
          reason: sandboxReason,
        },
        integrations: {
          "signup-enabled": process.env.TERRENCE_ENABLE_LOCAL_SIGNUP === "true",
          "saml-enabled": saml,
          "oidc-enabled": oidc,
          "ldap-enabled": ldap,
          "github-app-configured": typeof process.env.GITHUB_APP_ID === "string" && process.env.GITHUB_APP_ID !== "",
        },
        agents: {
          total: agentRows.reduce((sum: number, row: { status: string; n: number }): number => sum + row.n, 0),
          "by-status": Object.fromEntries(agentRows.map((row: { status: string; n: number }): [string, number] => [row.status, row.n])),
        },
      },
    };
  });
