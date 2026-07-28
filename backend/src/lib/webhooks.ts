import { db } from "../db";
import { configurationVersions, runs, githubAppInstallations } from "../db/schema";
import { eq } from "drizzle-orm";
import * as jwt from "jsonwebtoken";

// Types
type WebhookPayload = Record<string, unknown>;

async function getGitHubAppAccessToken(installationId: number): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId === undefined || privateKey === undefined || appId === "" || privateKey === "") {
    console.error("[terrence] GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured.");
    return null;
  }

  try {
    const key = privateKey.replace(/\\n/g, "\n");
    const token = (jwt as { sign: (p1: unknown, p2: unknown, p3: unknown) => string }).sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (10 * 60),
      iss: appId,
    }, key, { algorithm: "RS256" });

    const response = await fetch(`https://api.github.com/app/installations/${String(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      console.error("[terrence] Failed to fetch access token:", await response.text());
      return null;
    }

    const data = await response.json() as { token: string };
    return data.token;
  } catch (error) {
    console.error("[terrence] Exception creating GitHub access token:", error);
    return null;
  }
}

export async function handleGithubWebhook(eventName: string, payload: WebhookPayload): Promise<void> {
  let branch = "";
  let commitSha = "";
  let commitMessage = "";
  let commitUrl = "";
  let senderUsername = "";
  let cloneUrl = "";
  let repoFullName = "";
  let pullRequestNumber: number | undefined;

  const filesChanged = new Set<string>();

  if (eventName === "push") {
    branch = (typeof payload.ref === "string" ? payload.ref : "").replace("refs/heads/", "");
    commitSha = (typeof payload.after === "string" ? payload.after : "");
    commitMessage = (payload.head_commit as Record<string, unknown> | undefined)?.message as string;
    commitUrl = (payload.head_commit as Record<string, unknown> | undefined)?.url as string;
    senderUsername = (payload.sender as Record<string, unknown> | undefined)?.login as string;
    cloneUrl = (payload.repository as Record<string, unknown> | undefined)?.clone_url as string;
    repoFullName = (payload.repository as Record<string, unknown> | undefined)?.full_name as string;

    // Collect modified files for filtering
    const commits = (payload.commits as Record<string, unknown>[]) ?? [];
    for (const commit of commits) {
      const added = (commit.added as string[]) ?? [];
      const removed = (commit.removed as string[]) ?? [];
      const modified = (commit.modified as string[]) ?? [];
      [...added, ...removed, ...modified].forEach((f: string): void => { filesChanged.add(f); });
    }
  } else if (eventName === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
    branch = ((payload.pull_request as Record<string, unknown> | undefined)?.head as Record<string, unknown> | undefined)?.ref as string;
    commitSha = ((payload.pull_request as Record<string, unknown> | undefined)?.head as Record<string, unknown> | undefined)?.sha as string;
    commitMessage = (payload.pull_request as Record<string, unknown> | undefined)?.title as string;
    commitUrl = (payload.pull_request as Record<string, unknown> | undefined)?.html_url as string;
    senderUsername = (payload.sender as Record<string, unknown> | undefined)?.login as string;
    cloneUrl = (payload.repository as Record<string, unknown> | undefined)?.clone_url as string;
    repoFullName = (payload.repository as Record<string, unknown> | undefined)?.full_name as string;
    pullRequestNumber = typeof payload.number === "number" ? payload.number : undefined;
  }

  if (repoFullName === "" || branch === "") return;

  // Find workspaces linked to this repo
  const allWorkspaces = await db.query.workspaces.findMany();
  const matchedWorkspaces = allWorkspaces.filter((ws): boolean => {
    if (ws.vcsRepo === null || (ws.vcsRepo as { identifier?: string }).identifier !== repoFullName) return false;

    const wsBranch = (ws.vcsRepo as { branch?: string }).branch;
    if (wsBranch !== branch && wsBranch !== "" && wsBranch !== undefined) return false;

    // File trigger filtering
    if (ws.fileTriggersEnabled === true && filesChanged.size > 0) {
       // Working directory
       let matches = false;
       const wd = typeof ws.workingDirectory === "string" ? ws.workingDirectory : "";

       for (const file of filesChanged) {
         if (wd.length > 0 && file.startsWith(wd)) matches = true;
         if (wd.length === 0) matches = true; // No wd means root, matches all

         // Trigger prefixes
         if (Array.isArray(ws.triggerPrefixes) && ws.triggerPrefixes.length > 0) {
            for (const prefix of ws.triggerPrefixes) {
               const fullPrefix = wd.length > 0 ? `${wd}/${prefix}`.replace(/\/\//g, "/") : prefix;
               if (file.startsWith(fullPrefix)) matches = true;
            }
         }
       }
       if (!matches) return false;
    }

    return true;
  });

  if (matchedWorkspaces.length === 0) return;

  for (const ws of matchedWorkspaces) {
    // Determine token
    let token: string | null = null;


    if (typeof (ws.vcsRepo as { githubAppInstallationId?: string }).githubAppInstallationId === "string" && (ws.vcsRepo as { githubAppInstallationId?: string }).githubAppInstallationId !== "") {
      const ghaId = (ws.vcsRepo as { githubAppInstallationId: string }).githubAppInstallationId;
      const gha = await db.query.githubAppInstallations.findFirst({
        where: eq(githubAppInstallations.id, ghaId),
      });
      if (gha !== undefined) {

        token = await getGitHubAppAccessToken(gha.installationId);
      }
    }

    if (token === null) {
      console.error(`[terrence] Could not obtain token for workspace ${ws.id}`);
      // In test or missing token mode, we still create the run to fail natively later or test the workflow
    }

    const cvId = `cv-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
    const runId = `run-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;

    // Create CV
    const isSpeculative = eventName === "pull_request";

    if (isSpeculative && ws.speculativeEnabled === false) continue;
    if (!isSpeculative && ws.autoApplyRunTrigger !== true && ws.queueAllRuns !== true) continue;

    await db.insert(configurationVersions).values({
      id: cvId,
      workspaceId: ws.id,
      status: "pending",
      speculative: isSpeculative,
      source: "github",
      ingressAttributes: {
        commitSha,
        commitUrl,
        commitMessage,
        branch,
        pullRequestNumber,
        senderUsername,
        cloneUrl,
      },
      statusTimestamps: {},
      createdAt: Date.now(),
    });

    // Create Run
    await db.insert(runs).values({
      id: runId,
      workspaceId: ws.id,
      configurationVersionId: cvId,
      message: `Triggered by ${eventName === "push" ? "push" : "pull request"} to ${repoFullName}`,
      status: "pending",
      isDestroy: false,
      autoApply: ws.autoApply === true && !isSpeculative,
      planOnly: isSpeculative,
      statusTimestamps: { "pending-at": new Date().toISOString() },
      logToken: crypto.randomUUID(),
      createdAt: Date.now(),
    });

    // Fetch Tarball asynchronously
    await fetchAndSaveTarball(cvId, token, repoFullName, commitSha).catch(console.error);
  }
}

import { join } from "path";
import { writeFile } from "fs/promises";

export async function fetchAndSaveTarball(cvId: string, token: string, repoFullName: string, commitSha: string): Promise<void> {
  const url = `https://api.github.com/repos/${repoFullName}/tarball/${commitSha}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
     await db.update(configurationVersions).set({ status: "errored", error: "Failed to download tarball" }).where(eq(configurationVersions.id, cvId));
     return;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const CV_STORAGE_DIR = join(process.cwd(), "storage", "configuration_versions");
  void import("fs").then((fs): void => {
    if (!fs.existsSync(CV_STORAGE_DIR)) fs.mkdirSync(CV_STORAGE_DIR, { recursive: true });
  });

  const archiveName = `${cvId}.tar.gz`;
  const archivePath = join(CV_STORAGE_DIR, archiveName);

  await writeFile(archivePath, buffer);

  await db.update(configurationVersions).set({
     status: "uploaded",
     archivePath,
     statusTimestamps: { uploadedAt: new Date().toISOString() },
  }).where(eq(configurationVersions.id, cvId));
}
