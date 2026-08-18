/**
 * Terraform human-readable log diagnostics.
 *
 * Terraform renders warnings and errors either as box-drawing blocks
 * (color output, used by tfc-agent):
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
 * or as plain sections (no-color output, used by local execution):
 *
 *   Warning: Deprecated Parameter
 *
 *     on main.tf line 5, in resource "x" "y":
 *    42: lifecycle {
 *
 *   Use `resource "z" "w"` instead
 *
 *   (and 2 more similar warnings elsewhere)
 *
 * The log viewer surfaces these instead of forcing users to read the
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

// Lines that begin terraform/terrence sections unrelated to the current
// diagnostic. A plain diagnostic's body ends at the next such section.
const SECTION_START_RE = /^(No changes\.|Plan:|Apply complete|Terraform will perform|\[terrence\])/;
const DEDUP_NOTE_RE = /^\(and \d+ more similar warnings? elsewhere\)/;

function isSeverityLabel(line: string): TerraformDiagnosticSeverity | null {
  if (line.startsWith("Warning:")) return "warning";
  if (line.startsWith("Error:")) return "error";
  return null;
}

function severityTitle(severity: TerraformDiagnosticSeverity, label: string): string {
  const prefix = severity === "warning" ? "Warning:".length : "Error:".length;
  return label.slice(prefix).trim();
}

/**
 * Parse one box-drawing diagnostic block. `start` points at the opening
 * marker. Returns the diagnostic and the index just past the closing
 * marker, or null when the block contains no severity label.
 */
function parseBoxedDiagnostic(
  lines: readonly string[],
  start: number,
): { diagnostic: TerraformDiagnostic; nextIndex: number } | null {
  let index = start + 1;
  const content: string[] = [];
  while (index < lines.length && (lines[index]?.trim() ?? "") !== BLOCK_CLOSE) {
    const inner = lines[index] ?? "";
    content.push(inner.startsWith(LINE_MARK) ? inner.slice(LINE_MARK.length).replace(/^ /, "") : inner);
    index += 1;
  }
  if (index < lines.length) index += 1; // consume the closing marker

  const labelIndex = content.findIndex((candidate): boolean => isSeverityLabel(candidate) !== null);
  if (labelIndex < 0) return null;
  const label = content[labelIndex];
  if (label === undefined) return null;
  const severity = isSeverityLabel(label) ?? "warning";
  const title = severityTitle(severity, label);
  if (title === "") return null;
  const body = content.slice(labelIndex + 1).join("\n").replace(/\s+$/, "");
  return { diagnostic: { severity, title, body }, nextIndex: index };
}

/**
 * Parse one plain (no-color) diagnostic section. `start` points at the
 * "Warning:"/"Error:" header line. Consumes the indented location block
 * and any following body paragraphs, stopping at the next diagnostic
 * header, a box-drawing block, or a terraform/terrence section marker.
 * Returns the diagnostic and the index of the first unconsumed line.
 */
function parsePlainDiagnostic(
  lines: readonly string[],
  start: number,
): { diagnostic: TerraformDiagnostic; nextIndex: number } | null {
  const header = lines[start];
  if (header === undefined) return null;
  const severity = isSeverityLabel(header);
  if (severity === null) return null;
  const title = severityTitle(severity, header);
  if (title === "") return null;

  let index = start + 1;
  const bodyLines: string[] = [];
  let blankLineAfterHeader = false;

  // Skip the blank line(s) after the header, then take the indented
  // location/source block.
  while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
    blankLineAfterHeader = true;
    index += 1;
  }
  while (index < lines.length && (lines[index]?.startsWith(" ") ?? false)) {
    bodyLines.push(lines[index] ?? "");
    index += 1;
  }

  // Following blank-separated paragraphs belong to the diagnostic until
  // a new header, a boxed block, a known section start, or the dedup note
  // (which ends the diagnostic). A paragraph that starts with a box
  // opener is left unconsumed so the boxed parser can handle it.
  while (index < lines.length) {
    let skippedBlanks = 0;
    while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
      skippedBlanks += 1;
      index += 1;
    }
    const first = lines[index];
    if (first === undefined) break;
    const firstTrimmed = first.trim();
    if (
      isSeverityLabel(firstTrimmed) !== null
      || firstTrimmed.startsWith(BLOCK_OPEN)
      || SECTION_START_RE.test(firstTrimmed)
    ) break;
    if (skippedBlanks > 0) bodyLines.push("");
    const paragraphStart = index;
    while (index < lines.length && (lines[index]?.trim() ?? "") !== "") index += 1;
    bodyLines.push(lines.slice(paragraphStart, index).join("\n"));
    if (DEDUP_NOTE_RE.test(firstTrimmed)) break;
  }

  // Mirror the boxed format: the blank line after the severity label is
  // part of the body.
  const body = (blankLineAfterHeader && bodyLines.length > 0 ? "\n" : "") + bodyLines.join("\n").replace(/\s+$/, "");
  return { diagnostic: { severity, title, body }, nextIndex: index };
}

/**
 * Extract terraform diagnostics from a log. Accepts both the box-drawing
 * blocks (color output) and the plain sections (no-color output). Unrelated
 * log lines are never misread: boxed blocks are matched by their markers,
 * plain sections by their severity header and section boundaries.
 * Returns diagnostics in log order with ANSI codes removed.
 */
export function extractDiagnostics(logText: string): TerraformDiagnostic[] {
  const lines = logText.replace(ANSI_ESCAPE_RE, "").split(/\r?\n/);
  const diagnostics: TerraformDiagnostic[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const trimmed = line.trim();
    if (trimmed === BLOCK_OPEN) {
      const parsed = parseBoxedDiagnostic(lines, index);
      if (parsed !== null) {
        diagnostics.push(parsed.diagnostic);
        index = parsed.nextIndex;
        continue;
      }
    } else if (isSeverityLabel(line) !== null) {
      // Plain headers sit at column 0; indented lines are ordinary log
      // content even when they start with a severity word.
      const parsed = parsePlainDiagnostic(lines, index);
      if (parsed !== null) {
        diagnostics.push(parsed.diagnostic);
        index = parsed.nextIndex;
        continue;
      }
    }
    index += 1;
  }
  return diagnostics;
}
