import { db } from "../db";
import { workspaces, configurationVersions, runs } from "../db/schema";
import { sql } from "drizzle-orm";
import * as crypto from "crypto";

export async function handleGitlabWebhook(event: string, payload: any) {
  if (event !== "Push Hook") return;

  const repoFullName = payload.project?.path_with_namespace;
  if (!repoFullName) return;

  let branch = null;
  if (payload.ref && payload.ref.startsWith("refs/heads/")) {
    branch = payload.ref.replace("refs/heads/", "");
  }

  if (!branch) return;

  const commitSha = payload.after;
  const headCommit = payload.commits?.find((c: any) => c.id === commitSha) || payload.commits?.[0];

  const commitUrl = headCommit?.url;
  const commitMessage = headCommit?.message;
  const senderUsername = payload.user_username;
  const cloneUrl = payload.project?.git_http_url;

  const matchingWorkspaces = await db.select().from(workspaces).where(
    sql`json_extract(${workspaces.vcsRepo}, '$.identifier') = ${repoFullName} AND json_extract(${workspaces.vcsRepo}, '$.branch') = ${branch}`
  );

  for (const ws of matchingWorkspaces) {
    if (!ws.fileTriggersEnabled && !ws.queueAllRuns) continue;

    const cvId = `cv-${crypto.randomUUID()}`;
    await db.insert(configurationVersions).values({
      id: cvId,
      workspaceId: ws.id,
      status: "uploaded",
      speculative: false,
      provisional: false,
      source: "gitlab",
      ingressAttributes: {
        commitSha,
        commitUrl,
        commitMessage,
        branch,
        senderUsername,
        cloneUrl,
      },
      statusTimestamps: {
        uploadedAt: new Date().toISOString(),
      }
    });

    if (ws.queueAllRuns || ws.fileTriggersEnabled) {
      const runId = `run-${crypto.randomUUID()}`;
      await db.insert(runs).values({
        id: runId,
        workspaceId: ws.id,
        configurationVersionId: cvId,
        status: "pending",
        message: `Triggered by push to ${branch}`,
        autoApply: ws.autoApply || false,
        createdAt: Date.now(),
        statusTimestamps: {
            "plan-queueable-at": new Date().toISOString(),
        }
      });
    }
  }
}
