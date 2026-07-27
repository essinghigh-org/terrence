import { describe, expect, it, beforeEach } from "bun:test";
import { handleGithubWebhook } from "../src/webhooks/github";
import { handleGitlabWebhook } from "../src/webhooks/gitlab";
import { handleBitbucketWebhook } from "../src/webhooks/bitbucket";
import { db } from "../src/db";
import { organizations, workspaces, runs, configurationVersions } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("Webhooks", () => {
    let orgId: string;
    let wsId1: string;
    let wsId2: string;

    beforeEach(async () => {
        // cleanup
        await db.delete(organizations);

        orgId = "org-1";
        await db.insert(organizations).values({
            id: orgId,
            name: "webhook-org",
        });

        wsId1 = "ws-1";
        await db.insert(workspaces).values({
            id: wsId1,
            orgId,
            name: "ws-linked",
            vcsRepo: {
                identifier: "myorg/myrepo",
                branch: "main"
            },
            fileTriggersEnabled: true,
            queueAllRuns: true,
        });

        wsId2 = "ws-2";
        await db.insert(workspaces).values({
            id: wsId2,
            orgId,
            name: "ws-unlinked",
        });
    });

    it("github push webhook creates run for linked workspace", async () => {
        await handleGithubWebhook("push", {
            repository: { full_name: "myorg/myrepo", clone_url: "https://github.com/myorg/myrepo.git" },
            ref: "refs/heads/main",
            after: "1234567890abcdef",
            head_commit: { url: "https://github.com/myorg/myrepo/commit/123", message: "initial commit" },
            sender: { login: "octocat" }
        });

        const cvs = await db.select().from(configurationVersions).where(eq(configurationVersions.workspaceId, wsId1));
        expect(cvs.length).toBe(1);
        expect(cvs[0].ingressAttributes?.commitSha).toBe("1234567890abcdef");

        const triggeredRuns = await db.select().from(runs).where(eq(runs.workspaceId, wsId1));
        expect(triggeredRuns.length).toBe(1);
        expect(triggeredRuns[0].configurationVersionId).toBe(cvs[0].id);
    });

    it("gitlab push webhook creates run for linked workspace", async () => {
        await handleGitlabWebhook("Push Hook", {
            project: { path_with_namespace: "myorg/myrepo", git_http_url: "https://gitlab.com/myorg/myrepo.git" },
            ref: "refs/heads/main",
            after: "1234567890abcdef",
            commits: [{ id: "1234567890abcdef", url: "https://gitlab.com/myorg/myrepo/-/commit/123", message: "initial commit" }],
            user_username: "gitlab-user"
        });

        const cvs = await db.select().from(configurationVersions).where(eq(configurationVersions.workspaceId, wsId1));
        expect(cvs.length).toBe(1);
        expect(cvs[0].ingressAttributes?.commitSha).toBe("1234567890abcdef");
    });

    it("bitbucket push webhook creates run for linked workspace", async () => {
        await handleBitbucketWebhook("repo:push", {
            repository: { full_name: "myorg/myrepo", links: { clone: [{ name: "https", href: "https://bitbucket.org/myorg/myrepo.git" }] } },
            push: {
                changes: [{
                    new: {
                        type: "branch",
                        name: "main",
                        target: {
                            hash: "1234567890abcdef",
                            links: { html: { href: "https://bitbucket.org/myorg/myrepo/commits/123" } },
                            message: "initial commit"
                        }
                    }
                }]
            },
            actor: { username: "bitbucket-user" }
        });

        const cvs = await db.select().from(configurationVersions).where(eq(configurationVersions.workspaceId, wsId1));
        expect(cvs.length).toBe(1);
        expect(cvs[0].ingressAttributes?.commitSha).toBe("1234567890abcdef");
    });
});
