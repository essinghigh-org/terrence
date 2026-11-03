import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Result = Readonly<{ code: number; out: string; err: string }>;
type ScopeDocument = {
  data: {
    attributes: { kind: string; global: boolean };
    relationships: Record<string, { data: { id: string; type: string }[] }>;
  };
};

/** Real provider lifecycle, deliberately separate from the workspace fixture:
 * global tfpolicy must not block a workspace run that fixture is still testing. */
export async function exerciseStackPolicyProvider(
  options: Readonly<{
    directory: string;
    providerConfiguration: string;
    organization: string;
    stackId: string;
    run: (args: string[]) => Promise<Result>;
    readPolicySet: (id: string) => Promise<ScopeDocument>;
    setCompatibilityVersion: (version: string) => void;
  }>,
): Promise<void> {
  const { directory, run } = options;
  const ok = (result: Result): void => {
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  };
  await writeFile(join(directory, "providers.tf"), options.providerConfiguration);
  await writeFile(
    join(directory, "main.tf"),
    `
resource "tfe_policy_set" "stack_include" {
  organization = ${JSON.stringify(options.organization)}
  name = "stack-policy-inclusion-e2e"
  kind = "tfpolicy"
  global = false
}
resource "tfe_policy_set" "stack_exclude" {
  organization = ${JSON.stringify(options.organization)}
  name = "stack-policy-exclusion-e2e"
  kind = "tfpolicy"
  global = true
}
resource "tfe_stack_policy_set" "included" {
  stack_id = ${JSON.stringify(options.stackId)}
  policy_set_id = tfe_policy_set.stack_include.id
}
resource "tfe_stack_policy_set_exclusion" "excluded" {
  stack_id = ${JSON.stringify(options.stackId)}
  policy_set_id = tfe_policy_set.stack_exclude.id
}
output "include_set_id" { value = tfe_policy_set.stack_include.id }
output "exclude_set_id" { value = tfe_policy_set.stack_exclude.id }
output "include_id" { value = tfe_stack_policy_set.included.id }
output "exclude_id" { value = tfe_stack_policy_set_exclusion.excluded.id }
`,
  );
  ok(await run(["init", "-input=false", "-no-color"]));
  // Exercise the real provider's minimum-version check, then the exact floor.
  // Each CLI invocation configures a fresh provider process and discovers anew.
  options.setCompatibilityVersion("2.0.0");
  const unsupported = await run(["apply", "-auto-approve", "-input=false", "-no-color"]);
  expect(unsupported.code).not.toBe(0);
  expect(`${unsupported.out}\n${unsupported.err}`).toContain("requires Terraform Enterprise 2.1.0 or later");
  expect(`${unsupported.out}\n${unsupported.err}`).toContain("tfe_stack_policy_set.included");
  expect(`${unsupported.out}\n${unsupported.err}`).toContain("tfe_stack_policy_set_exclusion.excluded");
  options.setCompatibilityVersion("2.1.0");
  ok(await run(["apply", "-auto-approve", "-input=false", "-no-color"]));
  const output = await run(["output", "-json"]);
  ok(output);
  const values = JSON.parse(output.out) as Record<string, { value: string }>;
  const included = values["include_set_id"]!.value,
    excluded = values["exclude_set_id"]!.value;
  expect(values["include_id"]!.value).toBe(`${options.stackId}/${included}`);
  expect(values["exclude_id"]!.value).toBe(`${options.stackId}/${excluded}`);
  const identifiers = [{ id: options.stackId, type: "stacks" }];
  const includedDocument = await options.readPolicySet(included);
  const excludedDocument = await options.readPolicySet(excluded);
  expect(includedDocument.data.attributes).toMatchObject({ kind: "tfpolicy", global: false });
  expect(excludedDocument.data.attributes).toMatchObject({ kind: "tfpolicy", global: true });
  expect((await options.readPolicySet(included)).data.relationships["stacks"]!.data).toEqual(identifiers);
  expect((await options.readPolicySet(excluded)).data.relationships["stack-exclusions"]!.data).toEqual(identifiers);
  for (let i = 0; i < 2; i++) {
    ok(await run(["apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color"]));
    ok(await run(["plan", "-detailed-exitcode", "-input=false", "-no-color"]));
  }
  ok(await run(["apply", "-auto-approve", "-input=false", "-no-color"]));
  // Delete associations while their policy sets and stack still exist so API
  // readback proves DELETE worked, rather than relying on cascade cleanup.
  ok(
    await run([
      "destroy",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-target=tfe_stack_policy_set.included",
      "-target=tfe_stack_policy_set_exclusion.excluded",
    ]),
  );
  expect((await options.readPolicySet(included)).data.relationships["stacks"]!.data).toEqual([]);
  expect((await options.readPolicySet(excluded)).data.relationships["stack-exclusions"]!.data).toEqual([]);
  ok(await run(["destroy", "-auto-approve", "-input=false", "-no-color"]));
  const state = await run(["state", "list"]);
  ok(state);
  expect(state.out.trim()).toBe("");
}
