import { describe, expect, it } from "bun:test";
import { terraformVariableLine, toTfvarsContent } from "../../src/lib/tfvars";

/**
 * Typed variable-transport corpus (COMP-08, issue #718).
 *
 * After precedence is resolved, the serialization boundary must preserve
 * every value's meaning into Terraform. These fixtures pin the exact tfvars
 * lines for the value shapes operators actually store. Both execution modes
 * build their tfvars from the same contract — { key, value, hcl } in,
 * one `key = <expr>` line out — so the agent payload shape is covered by
 * the same cases: any divergence between local and agent execution is a
 * defect in the transport, not an untested interpretation.
 */
describe("variable-transport corpus", () => {
  it("encodes ordinary strings as JSON strings", () => {
    expect(terraformVariableLine("region", "us-east-1", false)).toBe(`region = "us-east-1"`);
    expect(terraformVariableLine("empty", "", false)).toBe(`empty = ""`);
  });

  it("keeps stored scalars as strings instead of guessing types", () => {
    // "true" is the four-character string, not a boolean: typing comes from
    // configuration, never from sniffing the stored value.
    expect(terraformVariableLine("flag", "true", false)).toBe(`flag = "true"`);
    expect(terraformVariableLine("count", "3", false)).toBe(`count = "3"`);
    expect(terraformVariableLine("nothing", "null", false)).toBe(`nothing = "null"`);
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(terraformVariableLine("quoted", `say "hi"`, false)).toBe(`quoted = "say \\"hi\\""`);
    expect(terraformVariableLine("path", `C:\\temp\\new`, false)).toBe(`path = "C:\\\\temp\\\\new"`);
    expect(terraformVariableLine("multiline", "line one\nline two", false)).toBe(`multiline = "line one\\nline two"`);
  });

  it("round-trips PEM-like multiline secrets byte-for-byte", () => {
    const pem = "-----BEGIN FAKE KEY-----\nAB:CD:EF:12:34\n-----END FAKE KEY-----\n";
    const line = terraformVariableLine("deploy_key", pem, false);
    expect(JSON.parse(line.split(" = ", 2)[1] ?? "null")).toBe(pem);
  });

  it("preserves Unicode without escaping to ASCII", () => {
    expect(terraformVariableLine("greeting", "héllo wörld 日本語", false)).toBe(`greeting = "héllo wörld 日本語"`);
  });

  it("passes raw HCL expressions through verbatim", () => {
    expect(terraformVariableLine("cidrs", `["10.0.0.0/8", "192.168.0.0/16"]`, true))
      .toBe(`cidrs = ["10.0.0.0/8", "192.168.0.0/16"]`);
    expect(terraformVariableLine("tags", `{ Env = "prod" }`, true)).toBe(`tags = { Env = "prod" }`);
    expect(terraformVariableLine("enabled", `true`, true)).toBe(`enabled = true`);
  });

  it("does not alter a malformed HCL expression (the engine rejects it, with the variable identified)", () => {
    const broken = `{ unclosed = `;
    expect(terraformVariableLine("broken", broken, true)).toBe(`broken = ${broken}`);
  });

  it("serializes sensitive values exactly like non-sensitive ones", () => {
    // Sensitivity controls disclosure, never encoding: masking happens at
    // read/display time, so the transport line must be identical.
    expect(terraformVariableLine("password", "s3cret!", false)).toBe(`password = "s3cret!"`);
  });

  it("builds identical lines from agent-payload-shaped inputs", () => {
    // The agent receives { key, value, hcl, sensitive } and must produce the
    // same tfvars this function produces locally.
    const agentParameter = { key: "region", value: "us-east-1", hcl: false, sensitive: false };
    expect(terraformVariableLine(agentParameter.key, agentParameter.value, agentParameter.hcl))
      .toBe(`region = "us-east-1"`);
    const agentHcl = { key: "cidrs", value: `["10.0.0.0/8"]`, hcl: true, sensitive: false };
    expect(terraformVariableLine(agentHcl.key, agentHcl.value, agentHcl.hcl)).toBe(`cidrs = ["10.0.0.0/8"]`);
  });

  it("joins lines into file content without a trailing newline", () => {
    expect(toTfvarsContent(["a = \"1\"", "b = \"2\""])).toBe("a = \"1\"\nb = \"2\"");
    expect(toTfvarsContent([])).toBe("");
  });
});
