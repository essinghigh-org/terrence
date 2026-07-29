import { describe, expect, it } from "bun:test";
import {
  validVariableAttributes,
  validVariableSetVariableAttributes,
  validVariableSetAttributes,
} from "../../src/lib/validation";

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
