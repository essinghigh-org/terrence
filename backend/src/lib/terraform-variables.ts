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

function attributeExpression(block: string, attribute: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)\\s*${attribute.replaceAll("-", "\\-")}\\s*=`, "m").exec(block);
  if (match === null) return undefined;
  const equals = block.indexOf("=", match.index);
  let start = equals + 1;
  while (start < block.length && /[ \t\r]/.test(block[start] ?? "")) start += 1;
  if (block.startsWith("<<", start)) {
    const end = skipHeredoc(block, start);
    return block.slice(start, end).trim();
  }

  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < block.length;) {
    if (block.startsWith("//", index) || block[index] === "#") {
      if (round === 0 && square === 0 && curly === 0) return block.slice(start, index).trim();
      index = skipLineComment(block, index);
      continue;
    }
    if (block.startsWith("/*", index)) {
      index = skipBlockComment(block, index);
      continue;
    }
    if (block.startsWith("<<", index)) {
      index = skipHeredoc(block, index);
      continue;
    }
    if (block[index] === "\"") {
      index = skipQuoted(block, index);
      continue;
    }
    const char = block[index];
    if (char === "(") round += 1;
    if (char === ")") round -= 1;
    if (char === "[") square += 1;
    if (char === "]") square -= 1;
    if (char === "{") curly += 1;
    if (char === "}") curly -= 1;
    if ((char === "\n" || char === ";") && round === 0 && square === 0 && curly === 0) {
      return block.slice(start, index).trim();
    }
    index += 1;
  }
  const value = block.slice(start).trim();
  return value === "" ? undefined : value;
}

export function parseTerraformVariables(source: string): readonly TerraformVariableMetadata[] {
  const variables = new Map<string, TerraformVariableMetadata>();
  const pattern = /\bvariable\s+("(?:\\.|[^"\\])*")\s*\{/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const name = quotedValue(rawName);
    const openingBrace = source.indexOf("{", match.index + match[0].length - 1);
    const closingBrace = matchingBrace(source, openingBrace);
    if (name === undefined || closingBrace === undefined) continue;
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
    pattern.lastIndex = closingBrace + 1;
  }
  return [...variables.values()].sort((left, right): number => left.name.localeCompare(right.name));
}

function jsonType(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function parseTerraformVariablesJson(source: string): readonly TerraformVariableMetadata[] {
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const rawVariables = (parsed as Record<string, unknown>).variable;
  if (rawVariables === null || typeof rawVariables !== "object" || Array.isArray(rawVariables)) return [];
  return Object.entries(rawVariables as Record<string, unknown>)
    .flatMap(([name, rawConfig]): TerraformVariableMetadata[] => {
      if (rawConfig === null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return [];
      const config = rawConfig as Record<string, unknown>;
      return [{
        name,
        type: config.type === undefined ? "any" : jsonType(config.type),
        description: typeof config.description === "string" ? config.description : null,
        hasDefault: Object.hasOwn(config, "default"),
        ...(Object.hasOwn(config, "default") ? { defaultValue: config.default } : {}),
        sensitive: config.sensitive === true,
        nullable: config.nullable !== false,
      }];
    })
    .sort((left, right): number => left.name.localeCompare(right.name));
}

export async function scanTerraformModuleVariables(directory: string): Promise<readonly TerraformVariableMetadata[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry): boolean => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")));
  const parsed = await Promise.all(files.map(async (entry): Promise<readonly TerraformVariableMetadata[]> => {
    const source = await readFile(join(directory, entry.name), "utf8");
    return entry.name.endsWith(".tf.json") ? parseTerraformVariablesJson(source) : parseTerraformVariables(source);
  }));
  const variables = new Map<string, TerraformVariableMetadata>();
  for (const metadata of parsed.flat()) variables.set(metadata.name, metadata);
  return [...variables.values()].sort((left, right): number => left.name.localeCompare(right.name));
}
