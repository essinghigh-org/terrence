import { describe, expect, it, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTerraformVariables,
  parseTerraformVariablesJson,
  parseTerraformVariablesWithDiagnostics,
  scanTerraformModuleVariablesWithDiagnostics,
} from "../src/lib/terraform-variables";

describe("Terraform module variable metadata", () => {
  it("parses typed HCL variables, defaults, descriptions, and sensitivity", () => {
    const variables = parseTerraformVariables(`
variable "region" {
  type        = string
  description = "AWS {deployment} region"
}

variable "replicas" {
  type      = number
  default   = 2
  nullable  = false
  sensitive = true
}

variable "service" {
  type = object({
    name = string
    tags = optional(map(string), {})
  })
  default = {
    name = "api"
    tags = {}
  }
}
`);

    expect(variables).toHaveLength(3);
    expect(variables[0]).toMatchObject({
      name: "region",
      type: "string",
      description: "AWS {deployment} region",
      hasDefault: false,
      sensitive: false,
      nullable: true,
    });
    expect(variables[1]).toMatchObject({
      name: "replicas",
      type: "number",
      hasDefault: true,
      defaultValue: 2,
      sensitive: true,
      nullable: false,
    });
    expect(variables[2]).toMatchObject({
      name: "service",
      type: "object({ name = string tags = optional(map(string), {}) })",
      hasDefault: true,
    });
  });

  it("parses Terraform JSON configuration variables", () => {
    expect(parseTerraformVariablesJson(JSON.stringify({
      variable: {
        enabled: { type: "bool", default: true, description: "Feature flag" },
        token: { type: "string", sensitive: true },
      },
    }))).toEqual([
      {
        name: "enabled",
        type: "bool",
        description: "Feature flag",
        hasDefault: true,
        defaultValue: true,
        sensitive: false,
        nullable: true,
      },
      {
        name: "token",
        type: "string",
        description: null,
        hasDefault: false,
        sensitive: true,
        nullable: true,
      },
    ]);
  });
});


test("ignores fake declarations and nested metadata in comments, strings and heredocs", () => {
  const source = `
# variable "ghost" {}
/* variable "ghost2" {} */
locals {
  example = <<-END
variable "ghost3" {}
END
  text = "variable \\"ghost4\\" {}"
}
variable "real" {
  default = {
    sensitive = true
    nullable = false
    description = "nested"
  }
  validation {
    condition = true
    error_message = "not metadata"
  }
  description = "日本語"
}
`;
  expect(parseTerraformVariables(source)).toEqual([expect.objectContaining({
    name: "real", sensitive: false, nullable: true, description: "日本語", hasDefault: true,
  })]);
});

test("skipped blocks are reported instead of silently dropped (issue #706)", () => {
  const source = `variable "good" {
  type = string
}
variable "broken" {
  type = string
`;
  const result = parseTerraformVariablesWithDiagnostics(source);
  expect(result.variables.map((variable) => variable.name)).toEqual(["good"]);
  expect(result.skipped).toEqual([{ name: "broken", reason: "unbalanced-braces" }]);
  // The plain parse keeps its shape: siblings survive, the broken block drops.
  expect(parseTerraformVariables(source).map((variable) => variable.name)).toEqual(["good"]);
});

test("directory scan names the file behind every skipped block (issue #706)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-hcl-skip-"));
  try {
    await writeFile(join(dir, "broken.tf"), `variable "lost" {\n  type = string\n`);
    await writeFile(join(dir, "fine.tf"), `variable "kept" {\n  type = string\n}\n`);
    const result = await scanTerraformModuleVariablesWithDiagnostics(dir);
    expect(result.variables.map((variable) => variable.name)).toEqual(["kept"]);
    expect(result.skipped).toEqual([{ file: "broken.tf", name: "lost", reason: "unbalanced-braces" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Issue #706: the lexical scanner must agree with real engine inspection on
// hostile inputs — comments, escaped strings, heredocs with fake blocks,
// nested keys named `sensitive`, complex types, validation blocks, Unicode
// descriptions, multiple files and .tf.json — or say so via diagnostics.
//
// NOTE: the shared test harness points TERRAFORM_CONFIG_INSPECT_PATH at a
// deterministic stub so archive/API coverage stays offline. This suite wants
// the genuine binary, so it resolves the prod search order directly
// (bundled backend/bin, then PATH) and skips when neither has it.
async function genuineInspectorBinary(): Promise<string | null> {
  const bundled = join(import.meta.dir, "..", "bin", "terraform-config-inspect");
  if (await Bun.file(bundled).exists()) return bundled;
  return Bun.which("terraform-config-inspect");
}

test("scanner agrees with terraform-config-inspect on the hostile corpus (issue #706)", async () => {
  const binary = await genuineInspectorBinary();
  if (binary === null) {
    console.warn("[hcl-scanner] skipping CLI comparison: terraform-config-inspect is unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "terrence-hcl-corpus-"));
  try {
    await writeFile(join(dir, "main.tf"), `# variable "ghost_line" {}
/* variable "ghost_block" {
     multiline
   } */
variable "region" {
  type        = string
  description = "Deploy r\\u00e9gion\\u65e5\\u672c\\u8a9e"
  default     = "us-east-1"
}
variable "replicas" {
  type      = number
  default   = 2
  nullable  = false
  sensitive = true
}
variable "service" {
  type = object({
    name = string
    tags = optional(map(string), {})
  })
  default = {
    name = "api"
    tags = {}
  }
  validation {
    condition     = length(var.service.name) > 0
    error_message = "name required"
  }
}
variable "secret_cfg" {
  type    = string
  default = "x"
}
locals {
  example = <<-END
variable "ghost_heredoc" {}
END
  quoted = "variable \\"ghost_str\\" {}"
  tricky = {
    sensitive = true
    nested    = "variable \\"ghost_nested\\" {}"
  }
}
variable "real_sensitive" {
  type      = string
  sensitive = true
}
`);
    await writeFile(join(dir, "extra.tf"), `variable "extra" {
  type    = bool
  default = true
}
`);
    await writeFile(join(dir, "data.tf.json"), JSON.stringify({
      variable: { jsoned: { type: "string", description: "from json", sensitive: true } },
    }));

    const scanned = await scanTerraformModuleVariablesWithDiagnostics(dir);
    expect(scanned.skipped).toEqual([]);

    const child = Bun.spawn([binary, "--json", dir], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    const inspected = (JSON.parse(stdout) as { variables: Record<string, { required?: boolean; sensitive?: boolean }> }).variables;

    const scannedByName = new Map(scanned.variables.map((variable) => [variable.name, variable]));
    expect([...scannedByName.keys()].sort()).toEqual(Object.keys(inspected).sort());
    for (const [name, meta] of Object.entries(inspected)) {
      const found = scannedByName.get(name);
      if (found === undefined) throw new Error(`scanner missed ${name}`);
      // required ⟺ no default; sensitivity must match exactly.
      expect({ name, required: !found.hasDefault }).toEqual({ name, required: meta.required === true });
      expect({ name, sensitive: found.sensitive }).toEqual({ name, sensitive: meta.sensitive === true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
