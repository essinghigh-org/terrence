import { describe, expect, it } from "bun:test";
import { renderTemplate } from "../../src/lib/notify";

const context = {
  event: "workspace.plan.failed",
  workspace: {
    id: "ws-1",
    name: "prod-infra",
    organizationName: "acme",
    tags: { environment: "production" },
  },
  run: {
    id: "run-1",
    message: "terraform plan failed",
    status: "errored",
    createdAt: 1234567890,
    createdBy: "alice",
    commitSha: "abc123",
    commitUrl: "https://example.com/abc123",
    commitMessage: "fix: infra",
    branch: "main",
    url: "https://terrence.example/app/acme/prod-infra/runs/run-1",
  },
};

describe("renderTemplate", () => {
  it("substitutes top-level and nested placeholders", () => {
    const out = renderTemplate(
      "Workspace {{workspace.name}} failed ({{run.status}})",
      context as never,
    );
    expect(out).toBe("Workspace prod-infra failed (errored)");
  });

  it("supports dotted paths through nested objects", () => {
    const out = renderTemplate("{{workspace.tags.environment}}", context as never);
    expect(out).toBe("production");
  });

  it("leaves unknown placeholders intact", () => {
    const out = renderTemplate("{{workspace.missing}} {{nope}}", context as never);
    expect(out).toBe("{{workspace.missing}} {{nope}}");
  });

  it("renders null/missing values as empty string", () => {
    const withNull = {
      ...context,
      run: { ...context.run, commitMessage: null },
    };
    const out = renderTemplate("[{{run.commitMessage}}]", withNull as never);
    expect(out).toBe("[]");
  });

  it("handles multi-line body templates", () => {
    const template = [
      "Run Failed",
      "Workspace: {{workspace.name}}",
      "Commit: {{run.commitSha}}",
      "Error: {{run.message}}",
      "View: {{run.url}}",
    ].join("\n");
    const out = renderTemplate(template, context as never);
    expect(out).toContain("Workspace: prod-infra");
    expect(out).toContain("Commit: abc123");
    expect(out).toContain("Error: terraform plan failed");
    expect(out).toContain("View: https://terrence.example/app/acme/prod-infra/runs/run-1");
  });

  it("treats the value at the path as a plain string (no code execution)", () => {
    const evil = { workspace: { name: "${process.exit(1)}" } };
    const out = renderTemplate("{{workspace.name}}", evil as never);
    expect(out).toBe("${process.exit(1)}");
  });
});
