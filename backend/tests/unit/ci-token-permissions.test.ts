import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");

function jobBlock(name: string, nextName: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${nextName}:\n`, start + 1);
  if (start < 0 || end < 0) throw new Error(`CI job block not found: ${name}`);
  return workflow.slice(start, end);
}

describe("CI token least privilege", (): void => {
  it("does not grant issue-write permission to provider tests that execute PR code", (): void => {
    const block = jobBlock("provider-compatibility", "provider-canary-review");
    expect(block).toContain("contents: read");
    expect(block).not.toContain("issues: write");
  });

  it("isolates scheduled issue creation in a no-checkout job", (): void => {
    const block = jobBlock("provider-canary-review", "cli-compatibility-report");
    expect(block).toContain("github.event_name == 'schedule'");
    expect(block).toContain("issues: write");
    expect(block).not.toContain("actions/checkout@");
    expect(block).not.toContain("bun install");
  });
});
