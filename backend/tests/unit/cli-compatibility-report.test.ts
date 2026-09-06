import { expect, test } from "bun:test";
import { compatibilityPage } from "../../scripts/report-cli-compatibility";
import matrix from "../e2e/cli_matrix.json";
import surface from "../e2e/provider_surface.json";
import lifecycleContract from "../../src/data/provider_lifecycle_contract.json" with { type: "json" };
import type { LifecycleContract } from "../../src/lib/provider-lifecycle";

const contract = lifecycleContract as LifecycleContract;

function lifecycleEvidence(): {
  contract_version: number;
  fixtures: unknown[];
} {
  return {
    contract_version: contract.version,
    fixtures: contract.fixtures.map((fixture) => ({
      id: fixture.id,
      status: "passed",
      resources: fixture.resources,
      behaviors: fixture.required_behaviors,
      ...(fixture.required_behaviors.includes("normalized-state-convergence")
        ? { normalized_state: { baseline_sha256: "a".repeat(64), restored_sha256: "a".repeat(64), equivalent: true } }
        : {}),
    })),
  };
}

test("compatibility publication requires every pinned journey and verified digest", () => {
  const reports = (["terraform", "tofu"] as const).flatMap((engine) => (["floor", "current"] as const).map((tier) => ({
    fixture: "backend/tests/e2e/provider_e2e.test.ts", engine, tier,
    versions: { terraform_version: matrix[engine][tier], provider_selections: { [engine === "terraform" ? "registry.terraform.io/hashicorp/tfe" : "registry.opentofu.org/hashicorp/tfe"]: surface.provider.split(" v")[1] } },
    database: "sqlite", sandbox: "disabled", completedAt: "2026-09-06T00:00:00.000Z", binarySha256: "a".repeat(64),
    lifecycle_contract: lifecycleEvidence(),
    claims: [
      { resources: ["tfe_workspace.ws", "tfe_variable.var", "tfe_variable_set.vs", "tfe_team.team", "tfe_project.proj", "tfe_policy.policy", "tfe_notification_configuration.nc", "tfe_registry_module.regmod"], behaviors: ["create", "read", "two-unchanged-plans", "unchanged-apply", "destroy"] },
      { resources: ["terraform_data.probe"], behaviors: ["remote-init", "remote-plan", "interactive-apply-approval", "remote-state-pull", "remote-unchanged-plan"] },
      { resources: ["tfe_variable_set.vs"], behaviors: ["set-description", "clear-description", "restore-description", "unchanged-plan-after-each-update"] },
      { resources: ["tfe_team.team"], behaviors: ["import-minimal-config", "unchanged-plan-after-import"] },
    ],
  })));
  expect(compatibilityPage(reports)).toContain(`| Terraform | floor | ${matrix.terraform.floor} |`);
  expect(() => compatibilityPage(reports.slice(1))).toThrow("Missing successful");
  for (const replacement of [
    { ...reports[0], binarySha256: "unverified" },
    { ...reports[0], claims: [] },
    { ...reports[0], claims: [null] },
    { ...reports[0], tier: "experimental" },
    { ...reports[0], sandbox: "required" },
    { ...reports[0], versions: { terraform_version: matrix.terraform.floor, provider_selections: {} } },
    { ...reports[0], lifecycle_contract: { contract_version: contract.version, fixtures: [] } },
  ]) {
    expect(() => compatibilityPage([replacement, ...reports.slice(1)])).toThrow();
  }
});
