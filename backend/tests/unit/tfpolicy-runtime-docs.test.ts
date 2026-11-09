import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const runtime = read("backend/docs/tfpolicy-runtime.md");
const compatibility = read("backend/docs/compatibility.md");
const supervisor = read("tools/tfpolicy-supervisor/README.md");
const example = read(".env.example");

// Documentation is the contract under test. Runtime admission and real-plugin
// behavior have separate owner/API tests; text assertions cannot establish them.
describe("published native policy support boundaries", () => {
  test("public entry points describe opt-in hosted and capable-agent execution", () => {
    for (const source of [runtime, compatibility, supervisor]) {
      expect(source).toContain("opt-in");
      expect(source).toContain("hosted");
      expect(source).toContain("operation.native-policy.v2");
      expect(source).not.toMatch(/does not yet execute|metadata compatibility, not Terraform policy execution/i);
      expect(source).not.toMatch(/current agents remain blocked/i);
    }
    expect(example).toContain("Opt-in hosted native policy execution");
    expect(example).toContain("TERRENCE_AGENT_NATIVE_POLICY_PROFILE");
    expect(example).toContain("legacy agents remain blocked");
  });

  test("runtime guidance retains admission, unsupported execution and recovery limits", () => {
    for (const boundary of [
      "TERRENCE_TFPOLICY_RUNTIME_PROFILE",
      "strict Terraform 1.17.1",
      "Landlock ABI 6",
      "zero capabilities",
      "finite memory/PID limits",
      "OpenTofu",
      "Stack deployments",
      "Legacy agents",
      "Native policy-set parameters",
      "targeted plans",
      "action-only runs",
      "deny-network execution",
      "Runtime errors and incomplete evidence cannot be overridden",
      "not rollback",
      "not automatically replayed",
    ]) {
      expect(runtime).toContain(boundary);
    }
    expect(runtime).toContain("HANDOFF.md#release-and-recovery");
    // The docs UI resolves relative links as docs slugs, not repository paths.
    expect(runtime).not.toMatch(/\]\(\.\.\//);
    expect(runtime).toContain(
      "https://github.com/essinghigh-org/terrence/blob/master/tools/tfpolicy-engine/HANDOFF.md",
    );
  });

  test("qualification separates production evidence from the stock transport fixture", () => {
    expect(runtime).toContain("eight official-plugin hosted-worker cases");
    expect(runtime).toContain("six production API/agent cases");
    expect(runtime).toContain("not approval authorization");
    expect(runtime).toContain("admitted: false");
    expect(runtime).toContain("Missing native prerequisites");
    expect(runtime).toContain("not run");
    const integration = read("tools/tfpolicy-supervisor/integration/README.md");
    expect(integration).toContain("Relationship to production qualification");
    expect(integration).toContain("HANDOFF.md#official-plugin-ci");
    expect(integration).toContain("admitted: false");
  });
});
