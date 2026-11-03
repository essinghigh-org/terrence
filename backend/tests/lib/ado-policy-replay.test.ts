import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, policies, policySets, policySetVersions } from "../../src/db/schema";
import { azureDevOpsZipToTarGz } from "../../src/lib/ado-archive";
import { synchronizeVcsPolicySet } from "../../src/lib/policy-sync";
import { azureDevOpsZipFixture } from "../fixtures/ado-zip";

test("ADO delivery retries preserve ready policy versions and recover pending versions", async () => {
  const id = crypto.randomUUID();
  const orgId = `org-${id}`;
  const policySetId = `polset-${id}`;
  await db.insert(organizations).values({ id: orgId, name: orgId });
  try {
    await db.insert(policySets).values({ id: policySetId, orgId, name: id, kind: "sentinel" });
    const policySet = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (policySet === undefined) throw new Error("Missing fixture policy set");
    const details = {
      deliveryId: `azure_devops:client:${id}`,
      branch: "main",
      repoFullName: "acme/project/_git/policies",
      commitSha: "a".repeat(40),
      filesChanged: new Set<string>(),
    };
    let downloads = 0;
    const fetchArchive = async (): Promise<Uint8Array> => {
      downloads++;
      return azureDevOpsZipToTarGz(
        azureDevOpsZipFixture([
          {
            name: "sentinel.hcl",
            data: 'policy "allow" {\n source = "allow.sentinel"\n enforcement_level = "hard-mandatory"\n}\n',
          },
          { name: "allow.sentinel", data: "main = rule { true }" },
        ]),
      );
    };
    await synchronizeVcsPolicySet(policySet, "azure_devops", details, fetchArchive);
    const first = await db.query.policySetVersions.findMany({ where: eq(policySetVersions.policySetId, policySetId) });
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("ready");
    const originalPolicies = await db.query.policies.findMany({ where: eq(policies.policySetId, policySetId) });
    await synchronizeVcsPolicySet(policySet, "azure_devops", details, fetchArchive);
    expect(downloads).toBe(1);
    expect(await db.query.policies.findMany({ where: eq(policies.policySetId, policySetId) })).toEqual(
      originalPolicies,
    );
    await db.update(policySetVersions).set({ status: "pending" }).where(eq(policySetVersions.id, first[0]!.id));
    await synchronizeVcsPolicySet(policySet, "azure_devops", details, fetchArchive);
    expect(downloads).toBe(2);
    const recovered = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, policySetId),
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("ready");
  } finally {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
});
