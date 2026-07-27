import { db } from "../db";
import { workspaces, configurationVersions, runs } from "../db/schema";
import { sql } from "drizzle-orm";
import * as crypto from "crypto";

export async function handleGithubWebhook(event: string, payload: any) {
  // Only handle push events for now
  if (event !== "push") return;

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) return;

  let branch = null;
  if (payload.ref && payload.ref.startsWith("refs/heads/")) {
    branch = payload.ref.replace("refs/heads/", "");
  }

  if (!branch) return; // Tag push or something else

  const commitSha = payload.after;
  const commitUrl = payload.head_commit?.url;
  const commitMessage = payload.head_commit?.message;
  const senderUsername = payload.sender?.login;
  const cloneUrl = payload.repository?.clone_url;

  // Find workspaces linked to this repo and branch
  const matchingWorkspaces = await db.select().from(workspaces).where(
    sql`json_extract(${workspaces.vcsRepo}, '$.identifier') = ${repoFullName} AND json_extract(${workspaces.vcsRepo}, '$.branch') = ${branch}`
  );

  for (const ws of matchingWorkspaces) {
    // If not queuing all runs automatically on push, skip unless file triggers match (simplified here for MVP)
    if (!ws.fileTriggersEnabled && !ws.queueAllRuns) {
      continue;
    }

    // Create Configuration Version
    const cvId = `cv-${crypto.randomUUID()}`;
    await db.insert(configurationVersions).values({
      id: cvId,
      workspaceId: ws.id,
      status: "uploaded", // simulate successful upload for webhook MVP since we don't fetch yet
      speculative: false,
      provisional: false,
      source: "github",
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

    // Create Run
    if (ws.queueAllRuns || ws.fileTriggersEnabled) { // Simplify triggers check
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
