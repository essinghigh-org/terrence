import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type TerraformVariableMetadata = Readonly<{
  name: string;
  type: string;
  description: string | null;
  hasDefault: boolean;
  defaultValue?: unknown;
  sensitive: boolean;
  nullable: boolean;
}>;

function quotedValue(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function literalValue(expression: string): unknown {
  const trimmed = expression.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // HCL expressions that are not JSON-compatible remain displayable source.
  }
  return quotedValue(trimmed) ?? trimmed;
}

function skipQuoted(input: string, start: number): number {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
    } else if (input[index] === "\"") {
      return index + 1;
    }
  }
  return input.length;
}

function skipBlockComment(input: string, start: number): number {
  const end = input.indexOf("*/", start + 2);
  return end === -1 ? input.length : end + 2;
}

function skipLineComment(input: string, start: number): number {
  const end = input.indexOf("\n", start);
  return end === -1 ? input.length : end;
}

function skipHeredoc(input: string, start: number): number {
  const headerEnd = input.indexOf("\n", start);
  if (headerEnd === -1) return input.length;
  const header = /^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(input.slice(start, headerEnd));
  if (header?.[1] === undefined) return start + 2;
  const delimiter = header[1];
  const lines = input.slice(headerEnd + 1).split("\n");
  let offset = headerEnd + 1;
  for (const line of lines) {
    offset += line.length + 1;
    if (line.trim() === delimiter) return Math.min(offset, input.length);
  }
  return input.length;
}

function matchingBrace(input: string, openingBrace: number): number | undefined {
  let depth = 1;
  for (let index = openingBrace + 1; index < input.length;) {
    if (input.startsWith("//", index) || input[index] === "#") {
      index = skipLineComment(input, index);
      continue;
    }
    if (input.startsWith("/*", index)) {
      index = skipBlockComment(input, index);
      continue;
    }
    if (input.startsWith("<<", index)) {
      index = skipHeredoc(input, index);
      continue;
    }
    if (input[index] === "\"") {
      index = skipQuoted(input, index);
      continue;
    }
    if (input[index] === "{") depth += 1;
    if (input[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

type AttributeNesting = Readonly<{ round: number; square: number; curly: number }>;

type AttributeTokenStep = Readonly<{ nextIndex: number; endsExpression: boolean }>;

function attributeTokenStep(block: string, index: number, nesting: AttributeNesting): AttributeTokenStep | undefined {
  if (block.startsWith("//", index) || block[index] === "#") {
    if (nesting.round === 0 && nesting.square === 0 && nesting.curly === 0) {
      return { nextIndex: index, endsExpression: true };
    }
    return { nextIndex: skipLineComment(block, index), endsExpression: false };
  }
  if (block.startsWith("/*", index)) {
    return { nextIndex: skipBlockComment(block, index), endsExpression: false };
  }
  if (block.startsWith("<<", index)) {
    return { nextIndex: skipHeredoc(block, index), endsExpression: false };
  }
  if (block[index] === "\"") {
    return { nextIndex: skipQuoted(block, index), endsExpression: false };
  }
  return undefined;
}

function advanceAttributeNesting(nesting: AttributeNesting, char: string | undefined): AttributeNesting {
  switch (char) {
    case "(": return { ...nesting, round: nesting.round + 1 };
    case ")": return { ...nesting, round: nesting.round - 1 };
    case "[": return { ...nesting, square: nesting.square + 1 };
    case "]": return { ...nesting, square: nesting.square - 1 };
    case "{": return { ...nesting, curly: nesting.curly + 1 };
    case "}": return { ...nesting, curly: nesting.curly - 1 };
    case undefined:
    default: return nesting;
  }
}

function isTopLevelAttributeTerminator(char: string | undefined, nesting: AttributeNesting): boolean {
  return (char === "\n" || char === ";")
    && nesting.round === 0
    && nesting.square === 0
    && nesting.curly === 0;
}

function scanAttributeExpression(block: string, start: number): string | undefined {
  let nesting: AttributeNesting = { round: 0, square: 0, curly: 0 };
  for (let index = start; index < block.length;) {
    const token = attributeTokenStep(block, index, nesting);
    if (token !== undefined) {
      if (token.endsExpression) return block.slice(start, index).trim();
      index = token.nextIndex;
      continue;
    }
    const char = block[index];
    nesting = advanceAttributeNesting(nesting, char);
    if (isTopLevelAttributeTerminator(char, nesting)) return block.slice(start, index).trim();
    index += 1;
  }
  const value = block.slice(start).trim();
  return value === "" ? undefined : value;
}

/** Metadata assistance only: tokenize lexical boundaries, not arbitrary HCL expressions.
 * ponytail: this is not an HCL validator; use the engine for authoritative diagnostics. */
function* topLevelMatches(input: string, pattern: RegExp): Generator<RegExpExecArray> {
  let nesting: AttributeNesting = { round: 0, square: 0, curly: 0 };
  for (let index = 0; index < input.length;) {
    if (input.startsWith("//", index) || input[index] === "#") { index = skipLineComment(input, index); continue; }
    if (input.startsWith("/*", index)) { index = skipBlockComment(input, index); continue; }
    if (input.startsWith("<<", index)) { index = skipHeredoc(input, index); continue; }
    if (input[index] === '\"') { index = skipQuoted(input, index); continue; }
    if (nesting.round === 0 && nesting.square === 0 && nesting.curly === 0) {
      pattern.lastIndex = index;
      const match = pattern.exec(input);
      if (match !== null) yield match;
    }
    nesting = advanceAttributeNesting(nesting, input[index]);
    index += 1;
  }
}

function attributeExpression(block: string, attribute: string): string | undefined {
  const pattern = new RegExp(`\\b${attribute}\\s*=`, "y");
  const match = topLevelMatches(block, pattern).next().value as RegExpExecArray | undefined;
  if (match === undefined) return undefined;
  let start = match.index + match[0].length;
  while (start < block.length && /[ \t\r]/.test(block[start] ?? "")) start += 1;
  if (block.startsWith("<<", start)) return block.slice(start, skipHeredoc(block, start)).trim();
  return scanAttributeExpression(block, start);
}

export type TerraformVariableSkip = Readonly<{
  /** Block name when the declaration could be identified, else null. */
  name: string | null;
  reason: "invalid-name" | "unbalanced-braces";
}>;

export function parseTerraformVariablesWithDiagnostics(source: string): Readonly<{
  variables: TerraformVariableMetadata[];
  skipped: TerraformVariableSkip[];
}> {
  const variables = new Map<string, TerraformVariableMetadata>();
  const skipped: TerraformVariableSkip[] = [];
  const pattern = /\bvariable\s+("(?:\\.|[^"\\])*")\s*\{/y;
  for (const match of topLevelMatches(source, pattern)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const name = quotedValue(rawName);
    const openingBrace = source.indexOf("{", match.index + match[0].length - 1);
    const closingBrace = matchingBrace(source, openingBrace);
    if (name === undefined || closingBrace === undefined) {
      skipped.push({ name: name ?? null, reason: name === undefined ? "invalid-name" : "unbalanced-braces" });
      continue;
    }
    const body = source.slice(openingBrace + 1, closingBrace);
    const typeExpression = attributeExpression(body, "type")?.replace(/\s+/g, " ").trim();
    const type = typeExpression === undefined || typeExpression === "" ? "any" : typeExpression;
    const rawDefault = attributeExpression(body, "default");
    const descriptionExpression = attributeExpression(body, "description");
    variables.set(name, {
      name,
      type,
      description: descriptionExpression === undefined ? null : quotedValue(descriptionExpression) ?? descriptionExpression,
      hasDefault: rawDefault !== undefined,
      ...(rawDefault === undefined ? {} : { defaultValue: literalValue(rawDefault) }),
      sensitive: attributeExpression(body, "sensitive")?.trim() === "true",
      nullable: attributeExpression(body, "nullable")?.trim() !== "false",
    });
  }
  const sorted = [...variables.values()].sort((left, right): number => left.name.localeCompare(right.name));
  return { variables: sorted, skipped };
}

/** Backwards-compatible parse without diagnostics (existing callers). */
export function parseTerraformVariables(source: string): readonly TerraformVariableMetadata[] {
  return parseTerraformVariablesWithDiagnostics(source).variables;
}

function jsonType(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function parseTerraformVariablesJson(source: string): readonly TerraformVariableMetadata[] {
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const rawVariables = (parsed as Record<string, unknown>)["variable"];
  if (rawVariables === null || typeof rawVariables !== "object" || Array.isArray(rawVariables)) return [];
  return Object.entries(rawVariables as Record<string, unknown>)
    .flatMap(([name, rawConfig]): TerraformVariableMetadata[] => {
      if (rawConfig === null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return [];
      const config = rawConfig as Record<string, unknown>;
      return [{
        name,
        type: config["type"] === undefined ? "any" : jsonType(config["type"]),
        description: typeof config["description"] === "string" ? config["description"] : null,
        hasDefault: Object.hasOwn(config, "default"),
        ...(Object.hasOwn(config, "default") ? { defaultValue: config["default"] } : {}),
        sensitive: config["sensitive"] === true,
        nullable: config["nullable"] !== false,
      }];
    })
    .sort((left, right): number => left.name.localeCompare(right.name));
}

export type TerraformVariableFileSkip = TerraformVariableSkip & Readonly<{ file: string }>;

export async function scanTerraformModuleVariablesWithDiagnostics(directory: string): Promise<Readonly<{
  variables: readonly TerraformVariableMetadata[];
  skipped: TerraformVariableFileSkip[];
}>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry): boolean => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")));
  const parsed = await Promise.all(files.map(async (entry) => {
    const source = await readFile(join(directory, entry.name), "utf8");
    if (entry.name.endsWith(".tf.json")) return { variables: parseTerraformVariablesJson(source), skipped: [] as TerraformVariableFileSkip[] };
    const result = parseTerraformVariablesWithDiagnostics(source);
    return { variables: result.variables, skipped: result.skipped.map((skip): TerraformVariableFileSkip => ({ ...skip, file: entry.name })) };
  }));
  const variables = new Map<string, TerraformVariableMetadata>();
  for (const metadata of parsed.flatMap((entry) => entry.variables)) variables.set(metadata.name, metadata);
  const sorted = [...variables.values()].sort((left, right): number => left.name.localeCompare(right.name));
  return { variables: sorted, skipped: parsed.flatMap((entry) => entry.skipped) };
}

export async function scanTerraformModuleVariables(directory: string): Promise<readonly TerraformVariableMetadata[]> {
  return (await scanTerraformModuleVariablesWithDiagnostics(directory)).variables;
}
