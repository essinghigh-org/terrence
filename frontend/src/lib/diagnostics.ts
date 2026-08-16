/**
 * Terraform human-readable log diagnostics.
 *
 * Terraform renders warnings and errors as box-drawing blocks in the
 * plan/apply log:
 *
 *   ╷
 *   │ Warning: Deprecated Parameter
 *   │
 *   │   on main.tf line 5, in resource "x" "y":
 *   │  42: lifecycle {
 *   │
 *   │ (and 2 more similar warnings elsewhere)
 *   ╵
 *
 * The log viewer surfaces these blocks instead of forcing users to read the
 * raw log to find them.
 */

export type TerraformDiagnosticSeverity = "warning" | "error";

export type TerraformDiagnostic = Readonly<{
  severity: TerraformDiagnosticSeverity;
  title: string;
  body: string;
}>;

// CSI / OSC / FE escape sequences. Older stored logs and third-party
// producers may still carry color codes around the box glyphs; strip them
// so block detection sees plain text.
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

const BLOCK_OPEN = "\u2577"; // ╷
const BLOCK_CLOSE = "\u2575"; // ╵
const LINE_MARK = "\u2502"; // │

function isSeverityLabel(line: string): TerraformDiagnosticSeverity | null {
  if (line.startsWith("Warning:")) return "warning";
  if (line.startsWith("Error:")) return "error";
  return null;
}

/**
 * Extract terraform diagnostic blocks from a log. Blocks are matched by
 * their box-drawing markers, so unrelated log lines are never misread.
 * Returns blocks in log order with the marker prefix and ANSI codes
 * removed.
 */
export function extractDiagnostics(logText: string): TerraformDiagnostic[] {
  const lines = logText.replace(ANSI_ESCAPE_RE, "").split(/\r?\n/);
  const diagnostics: TerraformDiagnostic[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim() !== BLOCK_OPEN) {
      index += 1;
      continue;
    }
    index += 1;
    const content: string[] = [];
    while (index < lines.length && (lines[index]?.trim() ?? "") !== BLOCK_CLOSE) {
      const inner = lines[index] ?? "";
      content.push(inner.startsWith(LINE_MARK)
        ? inner.slice(LINE_MARK.length).replace(/^ /, "")
        : inner);
      index += 1;
    }
    if (index < lines.length) index += 1; // consume the closing marker

    const labelIndex = content.findIndex((candidate): boolean => isSeverityLabel(candidate) !== null);
    if (labelIndex < 0) continue;
    const label = content[labelIndex];
    if (label === undefined) continue;
    const severity = isSeverityLabel(label) ?? "warning";
    const title = label.slice(severity === "warning" ? "Warning:".length : "Error:".length).trim();
    if (title === "") continue;
    const body = content.slice(labelIndex + 1).join("\n").replace(/\s+$/, "");
    diagnostics.push({ severity, title, body });
  }
  return diagnostics;
}
