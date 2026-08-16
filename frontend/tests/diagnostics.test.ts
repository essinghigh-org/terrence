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
});
