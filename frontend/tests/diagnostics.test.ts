import { describe, expect, test } from "bun:test";
import { extractDiagnostics } from "../src/lib/diagnostics";

describe("extractDiagnostics", () => {
  test("extracts a terraform warning block with location and dedup note", () => {
    const log = [
      "Terraform v1.15.8",
      "on linux_amd64",
      "Initializing plugins and modules...",
      "module.tf-github-repository.github_repository_file.release_workflow: Refreshing state... [id=tf-github-repository:.github/workflows/release.yml:master]",
      "\u2577", // ╷
      "\u2502 Warning: Deprecated Parameter",
      "\u2502 ",
      "\u2502   on modules/repo.tf line 5, in resource \"github_repository_file\" \"release_workflow\":",
      "\u2502  42: lifecycle {",
      "\u2502 ",
      "\u2502 (and 2 more similar warnings elsewhere)",
      "\u2575", // ╵
      "",
      "No changes. Your infrastructure matches the configuration.",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.title).toBe("Deprecated Parameter");
    expect(diagnostics[0]?.body).toBe(
      "\n  on modules/repo.tf line 5, in resource \"github_repository_file\" \"release_workflow\":\n"
      + " 42: lifecycle {\n\n"
      + "(and 2 more similar warnings elsewhere)",
    );
  });

  test("extracts error blocks with the same shape", () => {
    const log = [
      "\u2577",
      "\u2502 Error: No value for required variable",
      "\u2502 ",
      "\u2502   on main.tf line 12, in variable \"token\":",
      "\u2502  12:   description = \"GitHub token\"",
      "\u2502 ",
      "\u2502 The module root variable \"token\" is not set, and has no default value.",
      "\u2575",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      severity: "error",
      title: "No value for required variable",
      body: "\n  on main.tf line 12, in variable \"token\":\n 12:   description = \"GitHub token\"\n\nThe module root variable \"token\" is not set, and has no default value.",
    });
  });

  test("extracts multiple blocks in log order", () => {
    const log = [
      "\u2577",
      "\u2502 Warning: First warning",
      "\u2575",
      "Refreshing state...",
      "\u2577",
      "\u2502 Warning: Second warning",
      "\u2502 extra detail",
      "\u2575",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics.map((diagnostic): string => diagnostic.title)).toEqual([
      "First warning",
      "Second warning",
    ]);
    expect(diagnostics[1]?.body).toBe("extra detail");
  });

  test("strips ANSI codes wrapped around the box glyphs (pre-fix logs)", () => {
    const log = [
      "\u001b[33m\u2577\u001b[0m",
      "\u001b[0m\u001b[1m\u2502\u001b[0m\u001b[0m \u001b[1mWarning: Deprecated Parameter\u001b[0m",
      "\u001b[0m\u001b[1m\u2502\u001b[0m\u001b[0m",
      "\u001b[0m\u001b[1m\u2575\u001b[0m\u001b[0m",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.title).toBe("Deprecated Parameter");
  });

  test("returns nothing for logs without diagnostic blocks", () => {
    expect(extractDiagnostics("Refreshing state...\nNo changes.")).toEqual([]);
    expect(extractDiagnostics("")).toEqual([]);
  });

  test("ignores stray box glyphs in ordinary output", () => {
    const log = "resource output\n\u2577 symbol in a diff line\nNo changes.";
    expect(extractDiagnostics(log)).toEqual([]);
  });

  test("ignores truncated blocks with no severity label", () => {
    const log = ["\u2577", "\u2502 plain informational line", "\u2575"].join("\n");
    expect(extractDiagnostics(log)).toEqual([]);
  });

  test("extracts a plain no-color warning section (local execution)", () => {
    const log = [
      "No changes. Your infrastructure matches the configuration.",
      "",
      "Warning: Argument is deprecated",
      "",
      "  with module.aws_docs.github_repository_file.opencode_review,",
      "  on .terraform/modules/aws_docs/main.tf line 62, in resource \"github_repository_file\" \"opencode_review\":",
      "  62:   autocreate_branch = true",
      "",
      "Use `github_branch` resource instead",
      "",
      "(and 65 more similar warnings elsewhere)",
      "",
      "[terrence] Evaluated checks: 66 passed, 0 failed, 0 errored, 0 unknown.",
      "[terrence] Plan completed successfully.",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.title).toBe("Argument is deprecated");
    expect(diagnostics[0]?.body).toBe(
      "\n  with module.aws_docs.github_repository_file.opencode_review,\n"
      + "  on .terraform/modules/aws_docs/main.tf line 62, in resource \"github_repository_file\" \"opencode_review\":\n"
      + "  62:   autocreate_branch = true\n"
      + "\n"
      + "Use `github_branch` resource instead\n"
      + "\n"
      + "(and 65 more similar warnings elsewhere)",
    );
  });

  test("stops a plain warning at a following section header", () => {
    const log = [
      "Warning: Deprecated Parameter",
      "",
      "  on main.tf line 5:",
      "",
      "Use `github_branch` resource instead",
      "",
      "Plan: 1 to add, 0 to change, 0 to destroy.",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.title).toBe("Deprecated Parameter");
    expect(diagnostics[0]?.body).toBe("\n  on main.tf line 5:\n\nUse `github_branch` resource instead");
  });

  test("extracts plain error sections", () => {
    const log = [
      "Error: No value for required variable",
      "",
      "  on main.tf line 12, in variable \"token\":",
      "  12:   description = \"GitHub token\"",
      "",
      "The module root variable \"token\" is not set, and has no default value.",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      severity: "error",
      title: "No value for required variable",
      body: "\n  on main.tf line 12, in variable \"token\":\n  12:   description = \"GitHub token\"\n\nThe module root variable \"token\" is not set, and has no default value.",
    });
  });

  test("mixes plain and boxed diagnostics in log order", () => {
    const log = [
      "Warning: Plain first",
      "",
      "  on main.tf line 1:",
      "",
      "\u2577",
      "\u2502 Warning: Boxed second",
      "\u2502 extra detail",
      "\u2575",
      "Warning: Plain third",
      "",
      "  on main.tf line 3:",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics.map((diagnostic): string => diagnostic.title)).toEqual([
      "Plain first",
      "Boxed second",
      "Plain third",
    ]);
  });

  test("stops a plain warning before the terrence run footer", () => {
    const log = [
      "Warning: Deprecated Parameter",
      "",
      "  on main.tf line 5:",
      "",
      "[terrence] Plan completed successfully.",
    ].join("\n");

    const diagnostics = extractDiagnostics(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.body).toBe("\n  on main.tf line 5:");
  });

  test("does not treat indented log lines as plain headers", () => {
    const log = [
      "  Warning: this is a resource log line, not a diagnostic",
      "  Error: neither is this",
      "Refreshing state...",
    ].join("\n");

    expect(extractDiagnostics(log)).toEqual([]);
  });
});
