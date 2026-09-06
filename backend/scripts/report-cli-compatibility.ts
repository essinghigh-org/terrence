import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matrix from "../tests/e2e/cli_matrix.json";
import surface from "../tests/e2e/provider_surface.json";
import lifecycleContract from "../src/data/provider_lifecycle_contract.json" with { type: "json" };
import {
  assertLifecycleEvidence,
  type LifecycleContract,
  type LifecycleEvidence,
} from "../src/lib/provider-lifecycle";

type Report = {
  fixture: string;
  engine: "terraform" | "tofu";
  versions: { terraform_version: string; provider_selections: Record<string, string> };
  tier: string;
  binarySha256: string;
  database: string;
  sandbox: string;
  completedAt: string;
  lifecycle_contract: LifecycleEvidence;
  claims: { resources: string[]; behaviors: string[] }[];
};

const providerLifecycleContract = lifecycleContract as LifecycleContract;

/** Refuse a partial matrix instead of publishing a misleading support table. */
export function compatibilityPage(input: readonly unknown[]): string {
  const providerVersion = /v(\d+\.\d+\.\d+)/.exec(surface.provider)?.[1];
  const reports = input.map((raw): Report => {
    const report = raw as Partial<Report> | null;
    if (report === null || typeof report !== "object"
      || report.fixture !== "backend/tests/e2e/provider_e2e.test.ts"
      || !["terraform", "tofu"].includes(report.engine ?? "")
      || typeof report.versions?.terraform_version !== "string"
      || typeof report.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.binarySha256)
      || typeof report.completedAt !== "string" || !Number.isFinite(Date.parse(report.completedAt))
      || report.lifecycle_contract === undefined
      || !Array.isArray(report.claims)
      || !report.claims.every((claim: unknown): boolean => {
        if (typeof claim !== "object" || claim === null) return false;
        const item = claim as Record<string, unknown>;
        return Array.isArray(item["resources"]) && Array.isArray(item["behaviors"])
          && item["resources"].every((value: unknown): boolean => typeof value === "string")
          && item["behaviors"].every((value: unknown): boolean => typeof value === "string");
      })) {
      throw new Error("Invalid CLI lifecycle evidence");
    }
    try {
      assertLifecycleEvidence(providerLifecycleContract, report.lifecycle_contract as LifecycleEvidence);
    } catch (error) {
      throw new Error(`Invalid provider lifecycle contract evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    return report as Report;
  });
  const rows: string[] = [];
  for (const engine of ["terraform", "tofu"] as const) {
    for (const tier of ["floor", "current"] as const) {
      const version = matrix[engine][tier];
      const report = reports.filter((item): boolean => item.engine === engine && item.versions.terraform_version === version
        && item.database === "sqlite" && item.sandbox === "disabled" && item.tier === tier)
        .sort((a, b): number => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
      if (report === undefined) throw new Error(`Missing successful ${engine} ${version} (${tier}) evidence`);
      const provider = report.versions.provider_selections?.[engine === "terraform" ? "registry.terraform.io/hashicorp/tfe" : "registry.opentofu.org/hashicorp/tfe"];
      if (provider !== providerVersion) throw new Error(`Untracked provider in ${engine} ${version} evidence`);
      const hasClaim = (resource: string, behaviors: readonly string[]): boolean => report.claims.some((claim): boolean => claim.resources.includes(resource) && behaviors.every((behavior): boolean => claim.behaviors.includes(behavior)));
      for (const resource of ["tfe_workspace.ws", "tfe_variable.var", "tfe_variable_set.vs", "tfe_team.team", "tfe_project.proj", "tfe_policy.policy", "tfe_notification_configuration.nc", "tfe_registry_module.regmod"]) {
        if (!hasClaim(resource, ["create", "read", "two-unchanged-plans", "unchanged-apply", "destroy"])) throw new Error(`Missing ${resource} lifecycle proof for ${engine} ${version}`);
      }
      if (!hasClaim("terraform_data.probe", ["remote-init", "remote-plan", "interactive-apply-approval", "remote-state-pull", "remote-unchanged-plan"])
        || !hasClaim("tfe_variable_set.vs", ["set-description", "clear-description", "restore-description", "unchanged-plan-after-each-update"])
        || !hasClaim("tfe_team.team", ["import-minimal-config", "unchanged-plan-after-import"])) throw new Error(`Incomplete CLI journey for ${engine} ${version}`);
      rows.push(`| ${engine === "terraform" ? "Terraform" : "OpenTofu"} | ${tier} | ${version} | ${new Date(report.completedAt).toISOString()} | \`${report.binarySha256}\` |`);
    }
  }
  return `---
title: Tested CLI compatibility
category: Compatibility
order: 11
description: Generated results from the successful pinned CLI compatibility matrix.
---

# Tested CLI compatibility

Generated from successful lifecycle artifacts by \`backend/scripts/report-cli-compatibility.ts\`. Missing combinations, wrong provider versions or incomplete named lifecycle fixtures prevent generation. The latest successful CI run publishes the \`cli-compatibility-report\` artifact; this checked-in page is a release snapshot of that evidence.

| CLI | Pin | Tested version | Completed (UTC) | Binary SHA-256 |
|---|---|---|---|---|
${rows.join("\n")}

These combinations use SQLite, a local worker and a trusted HTTPS proxy. CLI archives pass upstream checksum verification and cached executables are checked against their integrity records. Provider version: \`hashicorp/tfe ${providerVersion}\`.

## What the results establish

- **Tested:** API login, CLI discovery/init, remote plan, interactive apply approval, state pull and an unchanged remote plan. The provider fixture also checks repeated convergence, normalized state after optional-value transitions, named priority-family pagination and permission probes, variable-set description transitions, minimal team import and destroy. Publication requires every named priority fixture in the lifecycle contract to pass.
- **Supported by contract:** CLI versions between each floor and current pin use the same remote-workflow API contract, but are not individually verified by this matrix. Discovery protocol versions and agent protocol support are separate from CLI version support.
- **Experimental:** versions newer than the current pin, including scheduled canaries. A failed canary opens a review item and does not change these pins or replace a successful matrix report.
- **Unsupported by this matrix:** versions below the floor, encrypted-state workflows, browser-based CLI login, alternate agent implementations, and untested plan/state formats. The state journey verifies a plain JSON v4 round trip; it does not establish compatibility with arbitrary future formats.

PostgreSQL and required-sandbox jobs provide separate evidence. They do not imply every database/security/version permutation was exercised. Full import/null coverage for every provider resource remains outside these measured claims.
`;
}

if (import.meta.main) {
  const [directory, output] = process.argv.slice(2);
  if (directory === undefined || output === undefined) throw new Error("Usage: report-cli-compatibility.ts RESULTS_DIR OUTPUT.md");
  const files = (await readdir(directory)).filter((name): boolean => name.endsWith("-lifecycle.json"));
  const reports = await Promise.all(files.map(async (name): Promise<unknown> => JSON.parse(await readFile(join(directory, name), "utf8")) as unknown));
  await writeFile(output, compatibilityPage(reports));
}
