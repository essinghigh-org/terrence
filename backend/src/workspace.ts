import { isAbsolute, normalize, resolve, sep } from "path";

export function normalizeWorkingDirectory(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    throw new Error("working-directory must be a relative path");
  }

  const normalized = normalize(value);
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("working-directory must be a relative path");
  }
  return normalized === "." ? null : normalized;
}

export function workspaceExecutionDirectory(root: string, value: unknown): string {
  const base = resolve(root);
  const target = resolve(base, normalizeWorkingDirectory(value) ?? ".");
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error("working-directory must stay inside the configuration");
  }
  return target;
}
