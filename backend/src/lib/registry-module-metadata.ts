import { stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { scanTerraformModuleVariables } from "./terraform-variables";

const MAX_INSPECT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_README_BYTES = 1024 * 1024;
const INSPECT_TIMEOUT_MS = 20_000;

export type RegistryModuleSectionMetadata = Readonly<{
  path: string;
  readme: string;
  description: string | null;
  inputs: readonly Readonly<{
    name: string;
    type: string;
    description: string | null;
    defaultValue?: unknown;
    required: boolean;
    sensitive: boolean;
    nullable: boolean;
  }>[];
  outputs: readonly Readonly<{ name: string; description: string | null; sensitive: boolean }>[];
  providers: readonly Readonly<{ name: string; source: string | null; versionConstraint: string | null }>[];
  modules: readonly Readonly<{ name: string; source: string | null; versionConstraint: string | null }>[];
  resources: readonly Readonly<{ name: string; type: string; mode: "managed" | "data" }>[];
}>;

export type RegistryModuleMetadata = RegistryModuleSectionMetadata & Readonly<{
  submodules: readonly RegistryModuleSectionMetadata[];
  examples: readonly RegistryModuleSectionMetadata[];
  diagnostics: readonly string[];
}>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function constraint(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value)) {
    const values = value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
    return values.length === 0 ? null : values.join(", ");
  }
  return null;
}

function renderedType(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (value === undefined || value === null) return "any";
  try {
    return JSON.stringify(value);
  } catch {
    return "any";
  }
}

async function readLimited(
  stream: Readonly<ReadableStream<Uint8Array>>,
  maxBytes: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.length;
      if (size > maxBytes) {
        onLimit();
        throw new Error(`terraform-config-inspect output exceeds ${maxBytes} bytes`);
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function inspectorBinary(): Promise<string> {
  const configured = process.env.TERRAFORM_CONFIG_INSPECT_PATH;
  if (configured !== undefined && configured !== "" && await Bun.file(configured).exists()) return configured;
  const bundled = join(import.meta.dir, "../../bin/terraform-config-inspect");
  if (await Bun.file(bundled).exists()) return bundled;
  const fromPath = Bun.which("terraform-config-inspect");
  if (fromPath !== null) return fromPath;
  throw new Error("terraform-config-inspect is unavailable");
}

async function inspectJson(directory: string): Promise<Readonly<{ value: Record<string, unknown>; diagnostics: string[] }>> {
  const binary = await inspectorBinary();
  const child = Bun.spawn([binary, "--json", directory], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
  });
  const stdoutPromise = readLimited(child.stdout, MAX_INSPECT_OUTPUT_BYTES, (): void => { child.kill(); });
  const stderrPromise = readLimited(child.stderr, 64 * 1024, (): void => { child.kill(); });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutPromise, stderrPromise]);
  let value: Record<string, unknown> = {};
  try {
    value = record(JSON.parse(stdout));
  } catch {
    if (exitCode !== 0) throw new Error(stderr.trim() || "terraform-config-inspect failed");
    throw new Error("terraform-config-inspect returned invalid JSON");
  }
  return {
    value,
    diagnostics: exitCode === 0 || stderr.trim() === "" ? [] : [stderr.trim().slice(0, 2_000)],
  };
}

async function readReadme(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const entry = entries.find((candidate): boolean => candidate.isFile() && /^readme(?:\.[^.]+)?$/i.test(candidate.name));
  if (entry === undefined) return "";
  const path = join(directory, entry.name);
  if ((await stat(path)).size > MAX_README_BYTES) return "";
  return readFile(path, "utf8");
}

function descriptionFromReadme(readme: string): string | null {
  const paragraph = readme
    .split(/\n\s*\n/)
    .map((value): string => value.trim())
    .find((value): boolean => value !== "" && !value.startsWith("#") && !value.startsWith("![") && !value.startsWith("[!"));
  return paragraph?.replace(/\s+/g, " ").slice(0, 500) ?? null;
}

async function inspectSection(directory: string, path: string): Promise<Readonly<{ section: RegistryModuleSectionMetadata; diagnostics: string[] }>> {
  const [{ value, diagnostics }, variables, readme] = await Promise.all([
    inspectJson(directory),
    scanTerraformModuleVariables(directory),
    readReadme(directory).catch((): string => ""),
  ]);
  const variableMap = record(value.variables);
  const inputs = variables.map((variable) => {
    const inspected = record(variableMap[variable.name]);
    return {
      name: variable.name,
      type: renderedType(inspected.type ?? variable.type),
      description: stringOrNull(inspected.description) ?? variable.description,
      ...(variable.hasDefault ? { defaultValue: variable.defaultValue } : {}),
      required: inspected.required === true || !variable.hasDefault,
      sensitive: inspected.sensitive === true || variable.sensitive,
      nullable: variable.nullable,
    };
  });
  const outputs = Object.entries(record(value.outputs)).map(([name, raw]) => {
    const output = record(raw);
    return { name, description: stringOrNull(output.description), sensitive: output.sensitive === true };
  });
  const providers = Object.entries(record(value.required_providers)).map(([name, raw]) => {
    const provider = record(raw);
    return {
      name,
      source: stringOrNull(provider.source),
      versionConstraint: constraint(provider.version_constraints),
    };
  });
  const modules = Object.entries(record(value.module_calls)).map(([name, raw]) => {
    const module = record(raw);
    return {
      name,
      source: stringOrNull(module.source),
      versionConstraint: constraint(module.version),
    };
  });
  const resources = ([
    ["managed", value.managed_resources],
    ["data", value.data_resources],
  ] as const).flatMap(([mode, raw]) => Object.entries(record(raw)).map(([address, item]) => {
    const resource = record(item);
    return {
      name: stringOrNull(resource.name) ?? address,
      type: stringOrNull(resource.type) ?? address.split(".")[0] ?? address,
      mode,
    };
  }));
  return {
    section: {
      path,
      readme,
      description: descriptionFromReadme(readme),
      inputs,
      outputs,
      providers,
      modules,
      resources,
    },
    diagnostics,
  };
}

async function conventionalSections(root: string, directoryName: "modules" | "examples"): Promise<Readonly<{ sections: RegistryModuleSectionMetadata[]; diagnostics: string[] }>> {
  const parent = join(root, directoryName);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return { sections: [], diagnostics: [] };
  }
  const directories = entries.filter((entry): boolean => entry.isDirectory()).slice(0, 100);
  const inspected = await Promise.all(directories.map(async (entry) => {
    const directory = join(parent, entry.name);
    const files = await readdir(directory, { withFileTypes: true });
    if (!files.some((file): boolean => file.isFile() && (file.name.endsWith(".tf") || file.name.endsWith(".tf.json")))) return undefined;
    return inspectSection(directory, `${directoryName}/${entry.name}`);
  }));
  return {
    sections: inspected.flatMap((result): RegistryModuleSectionMetadata[] => result === undefined ? [] : [result.section]),
    diagnostics: inspected.flatMap((result): string[] => result?.diagnostics ?? []),
  };
}

export async function inspectRegistryModule(root: string): Promise<RegistryModuleMetadata> {
  const [primary, submodules, examples] = await Promise.all([
    inspectSection(root, "."),
    conventionalSections(root, "modules"),
    conventionalSections(root, "examples"),
  ]);
  return {
    ...primary.section,
    path: ".",
    submodules: submodules.sections,
    examples: examples.sections,
    diagnostics: [...primary.diagnostics, ...submodules.diagnostics, ...examples.diagnostics],
  };
}
