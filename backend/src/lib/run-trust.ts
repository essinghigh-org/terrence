import { eq } from "drizzle-orm";
import { db } from "../db";
import { configurationVersions } from "../db/schema";

/** API/CLI uploads are permission-gated; VCS PR code needs admission evidence. */
export async function runConfigurationTrusted(
  run: Readonly<{ configurationVersionId: string | null }>,
): Promise<boolean> {
  if (run.configurationVersionId === null) return true;
  const configuration = await db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, run.configurationVersionId),
  });
  if (configuration === undefined) return false;
  const ingress = configuration.ingressAttributes as Readonly<Record<string, unknown>> | null;
  const vcs = ["github", "gitlab", "bitbucket"].includes(configuration.source ?? "");
  if (!vcs || (!configuration.speculative && ingress?.["pullRequestNumber"] === undefined)) return true;
  // Legacy queued PRs have no verified repository identity. Fail closed before
  // decrypting variables, seeding state, or honoring their existing run tokens.
  return ingress?.["trustedPullRequest"] === true;
}
