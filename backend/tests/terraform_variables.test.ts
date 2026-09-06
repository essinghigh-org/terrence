import { describe, expect, it, test } from "bun:test";
import {
  parseTerraformVariables,
  parseTerraformVariablesJson,
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
