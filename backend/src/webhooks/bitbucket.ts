import { db } from "../db";
import { workspaces, configurationVersions, runs } from "../db/schema";
import { sql } from "drizzle-orm";
import * as crypto from "crypto";

export async function handleBitbucketWebhook(event: string, payload: any) {
  if (event !== "repo:push") return;

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) return;

  const pushChanges = payload.push?.changes || [];
  for (const change of pushChanges) {
      if (change.new?.type !== "branch") continue;

      const branch = change.new.name;
      const target = change.new.target;

      if (!branch || !target) continue;

      const commitSha = target.hash;
      const commitUrl = target.links?.html?.href;
      const commitMessage = target.message;
      const senderUsername = payload.actor?.nickname || payload.actor?.username;
      const cloneUrl = payload.repository?.links?.clone?.find((l: any) => l.name === 'https')?.href;

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
          source: "bitbucket",
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
}
