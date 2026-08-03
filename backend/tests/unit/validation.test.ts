import { describe, expect, it } from "bun:test";
import {
  decodeStatePayload,
  isUniqueConstraintError,
  parseStatePayload,
  parseTerraformStatePayload,
  tokenExpiry,
  validVariableAttributes,
  validVariableSetVariableAttributes,
  validVariableSetAttributes,
} from "../../src/lib/validation";

describe("state payload helpers", () => {
  it("decodes a base64 JSON payload after the plain JSON parse fails", () => {
    const encoded = Buffer.from(JSON.stringify({ serial: 3 })).toString("base64");
    expect(decodeStatePayload(encoded)).toBe('{"serial":3}');
  });

  it("keeps an undecodable payload unchanged", () => {
    expect(decodeStatePayload("not-json-or-base64")).toBe("not-json-or-base64");
  });

  it("returns null when the parsed payload is not an object", () => {
    expect(parseStatePayload("not-json")).toBeNull();
    expect(parseStatePayload("[]")).toBeNull();
  });
});

describe("validVariableAttributes", () => {
  it("accepts a full valid variable", () => {
    expect(validVariableAttributes({
      key: "my_var",
      value: "hello",
      category: "terraform",
      sensitive: false,
      hcl: false,
      description: "Test var",
    })).toBeTrue();
  });

  it("rejects null", () => {
    expect(validVariableAttributes(null)).toBeFalse();
  });

  it("rejects arrays", () => {
    expect(validVariableAttributes([])).toBeFalse();
  });

  it("rejects unknown fields", () => {
    expect(validVariableAttributes({ key: "x", value: "y", unknownField: true })).toBeFalse();
  });

  it("requires key to be a valid identifier", () => {
    expect(validVariableAttributes({ key: "valid_name", value: "x" })).toBeTrue();
    expect(validVariableAttributes({ key: "", value: "x" })).toBeFalse();
    expect(validVariableAttributes({ key: "123invalid", value: "x" })).toBeFalse();
  });

  it("accepts partial without key", () => {
    expect(validVariableAttributes({ value: "x" }, true)).toBeTrue();
  });

  it("rejects partial with no fields", () => {
    expect(validVariableAttributes({}, true)).toBeFalse();
  });

  it("requires value when not partial", () => {
    expect(validVariableAttributes({ key: "x" })).toBeFalse();
  });

  it("accepts optional fields when valid", () => {
    expect(validVariableAttributes({
      key: "x", value: "y", category: "env", sensitive: true, hcl: true, description: null,
    })).toBeTrue();
  });

  it("rejects invalid category", () => {
    expect(validVariableAttributes({ key: "x", value: "y", category: "invalid" })).toBeFalse();
  });

  it("rejects non-boolean sensitive", () => {
    expect(validVariableAttributes({ key: "x", value: "y", sensitive: "yes" })).toBeFalse();
  });

  it("rejects non-boolean hcl", () => {
    expect(validVariableAttributes({ key: "x", value: "y", hcl: "yes" })).toBeFalse();
  });

  it("rejects non-string description", () => {
    expect(validVariableAttributes({ key: "x", value: "y", description: 42 })).toBeFalse();
  });
});

describe("validVariableSetVariableAttributes", () => {
  it("accepts a full valid variable set variable", () => {
    expect(validVariableSetVariableAttributes({
      key: "region",
      value: "us-east-1",
      category: "terraform",
      sensitive: false,
      hcl: false,
      description: "Deployment region",
    })).toBeTrue();
  });

  it("rejects hcl=true (not allowed in set variables)", () => {
    expect(validVariableSetVariableAttributes({ key: "x", value: "y", hcl: true })).toBeFalse();
  });

  it("accepts partial without key", () => {
    expect(validVariableSetVariableAttributes({ value: "z" }, true)).toBeTrue();
  });
});

describe("validVariableSetAttributes", () => {
  it("accepts a full valid variable set", () => {
    expect(validVariableSetAttributes({
      name: "Production Variables",
      description: "Shared config",
      global: false,
      priority: true,
    })).toBeTrue();
  });

  it("rejects empty fields", () => {
    expect(validVariableSetAttributes({})).toBeFalse();
  });

  it("rejects null attributes", () => {
    expect(validVariableSetAttributes(null)).toBeFalse();
  });

  it("requires non-empty name", () => {
    expect(validVariableSetAttributes({ name: "" })).toBeFalse();
    expect(validVariableSetAttributes({ name: "Valid" })).toBeTrue();
  });

  it("accepts partial without name", () => {
    expect(validVariableSetAttributes({ global: true }, true)).toBeTrue();
  });

  it("rejects unknown fields", () => {
    expect(validVariableSetAttributes({ name: "x", invalidField: "y" })).toBeFalse();
  });

  it("rejects non-boolean global", () => {
    expect(validVariableSetAttributes({ name: "x", global: "yes" })).toBeFalse();
  });

  it("accepts null description", () => {
    expect(validVariableSetAttributes({ name: "x", description: null })).toBeTrue();
  });
});

describe("isUniqueConstraintError", () => {
  it("matches an error with the SQLITE_CONSTRAINT_UNIQUE code", () => {
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: users.email" })).toBeTrue();
  });

  it("matches a UNIQUE constraint message on the error itself", () => {
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: workspaces.name"))).toBeTrue();
  });

  it("matches a UNIQUE constraint surfaced on the error cause", () => {
    expect(isUniqueConstraintError({ cause: { code: "SQLITE_CONSTRAINT_UNIQUE" } })).toBeTrue();
    expect(isUniqueConstraintError({ cause: new Error("UNIQUE constraint failed: tokens.description") })).toBeTrue();
  });

  it("rejects unrelated errors and values", () => {
    expect(isUniqueConstraintError(new Error("no such table: workspaces"))).toBeFalse();
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBeFalse();
    expect(isUniqueConstraintError(null)).toBeFalse();
    expect(isUniqueConstraintError("boom")).toBeFalse();
    expect(isUniqueConstraintError(undefined)).toBeFalse();
  });
});

describe("tokenExpiry", () => {
  it("returns null for undefined and null", () => {
    expect(tokenExpiry(undefined)).toBeNull();
    expect(tokenExpiry(null)).toBeNull();
  });

  it("returns NaN for non-string or non-date-shaped input", () => {
    expect(tokenExpiry(12345)).toBeNaN();
    expect(tokenExpiry({})).toBeNaN();
    expect(tokenExpiry("tomorrow")).toBeNaN();
    expect(tokenExpiry("2026-12-31")).toBeNaN();
  });

  it("parses an ISO-8601 date string", () => {
    expect(tokenExpiry("2026-12-31T23:59:59Z")).toBe(Date.parse("2026-12-31T23:59:59Z"));
  });

  it("parses a date string without a timezone", () => {
    const parsed = tokenExpiry("2026-12-31T23:59:59");
    expect(parsed).not.toBeNaN();
    expect(parsed).toBe(Date.parse("2026-12-31T23:59:59"));
  });
});

describe("parseTerraformStatePayload", () => {
  const validState = {
    version: 4,
    serial: 1,
    lineage: "abc-123",
    terraform_version: "1.9.0",
    outputs: {},
    resources: [{
      mode: "managed",
      type: "aws_instance",
      name: "web",
      provider: "provider[\"registry.terraform.io/hashicorp/aws\"]",
      instances: [{ schema_version: 0, sensitive_attributes: [], dependencies: [], attributes: {} }],
    }],
  };

  it("accepts a valid v4 state object", () => {
    expect(parseTerraformStatePayload(JSON.stringify(validState))).toEqual(validState);
  });

  it("accepts optional instance fields", () => {
    const state = {
      ...validState,
      resources: [{
        mode: "data",
        type: "aws_ami",
        name: "ubuntu",
        provider: "provider[\"registry.terraform.io/hashicorp/aws\"]",
        instances: [{ attributes: {} }],
      }],
    };
    expect(parseTerraformStatePayload(JSON.stringify(state))).not.toBeNull();
  });

  it("rejects a state whose version is not 4", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, version: 3 }))).toBeNull();
  });

  it("rejects a non-integer or negative serial", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, serial: 1.5 }))).toBeNull();
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, serial: -1 }))).toBeNull();
  });

  it("rejects a missing or empty lineage", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, lineage: "" }))).toBeNull();
    const { lineage: _lineage, ...noLineage } = validState;
    expect(parseTerraformStatePayload(JSON.stringify(noLineage))).toBeNull();
  });

  it("rejects a non-array resources field", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, resources: {} }))).toBeNull();
  });

  it("rejects resources with invalid mode or missing fields", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, resources: [{ ...validState.resources[0], mode: "import" }] }))).toBeNull();
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, resources: [{ ...validState.resources[0], name: "" }] }))).toBeNull();
  });

  it("rejects instances with a non-integer schema_version", () => {
    expect(parseTerraformStatePayload(JSON.stringify({
      ...validState,
      resources: [{ ...validState.resources[0], instances: [{ schema_version: "nope" }] }],
    }))).toBeNull();
  });

  it("rejects a non-string terraform_version and a non-object outputs", () => {
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, terraform_version: 42 }))).toBeNull();
    expect(parseTerraformStatePayload(JSON.stringify({ ...validState, outputs: [] }))).toBeNull();
  });

  it("rejects invalid JSON and non-object payloads", () => {
    expect(parseTerraformStatePayload("not-json")).toBeNull();
    expect(parseTerraformStatePayload(null)).toBeNull();
    expect(parseTerraformStatePayload("[]")).toBeNull();
  });
});
