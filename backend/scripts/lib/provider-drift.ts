import { createHash } from "node:crypto";

export type SurfaceEntry = Readonly<{ name: string; status: string; schema_hash?: string }>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(schema)))
    .digest("hex");
}

/** JSON paths identify changed schema contracts, including nested blocks and flags. */
export function changedSchemaPaths(before: unknown, after: unknown, path = "$"): string[] {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const old = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    return [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .sort()
      .flatMap((key) => changedSchemaPaths(old[key], next[key], `${path}[${JSON.stringify(key)}]`));
  }
  return [path];
}

export function reviewEntries(
  existing: readonly SurfaceEntry[],
  next: Record<string, unknown>,
  baseline?: Record<string, unknown>,
): string[] {
  const old = new Map(existing.map((entry) => [entry.name, entry]));
  const lines: string[] = [];
  for (const name of [...new Set([...old.keys(), ...Object.keys(next)])].sort()) {
    const previous = old.get(name);
    if (!Object.hasOwn(next, name)) {
      lines.push(`- Removed: \`${name}\``);
      continue;
    }
    if (previous === undefined) {
      lines.push(`- Added: \`${name}\` — backend gap`);
      continue;
    }
    if (previous.schema_hash === schemaHash(next[name])) continue;
    lines.push(
      `- ${previous.schema_hash === undefined ? "Baseline missing" : "Schema changed"}: \`${name}\` (inventory status: ${previous.status}; behavioral review required)`,
    );
    if (baseline !== undefined && Object.hasOwn(baseline, name)) {
      const paths = changedSchemaPaths(baseline[name], next[name]);
      for (const path of paths) lines.push(`  - \`${path}\``);
      if (paths.length === 0)
        lines.push("  - Tagged baseline matches target; catalog hash differs. Investigate catalog provenance.");
    }
  }
  return lines.length > 0 ? lines : ["- No schema changes. This does not establish behavioral compatibility."];
}

export type UpstreamFile = Readonly<{ filename: string; status: string }>;
export function productionFiles(files: readonly UpstreamFile[]): UpstreamFile[] {
  return files
    .filter(
      (file) =>
        (file.filename.endsWith(".go") && !file.filename.endsWith("_test.go")) ||
        /(^|\/)go\.(mod|sum)$/.test(file.filename),
    )
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

export function renderReview(options: {
  current: string | null;
  target: string;
  resources: string[];
  dataSources: string[];
  files: readonly UpstreamFile[];
  truncated: boolean;
}): string {
  const { current, target } = options;
  const repository = "https://github.com/hashicorp/terraform-provider-tfe";
  return [
    "# Provider compatibility review",
    "",
    `Provider: ${current === null ? "unknown baseline" : `v${current}`} → v${target}`,
    "",
    "Inventory statuses are retained for fixture bookkeeping, NOT compatibility sign-off. A schema-stable release can still change validation, defaults, HTTP requests, read normalization or destroy behavior.",
    "",
    `- [Target release notes](${repository}/releases/tag/v${target})`,
    ...(current === null
      ? ["- No baseline version: audit the complete provider before claiming compatibility."]
      : [`- [Full upstream source comparison](${repository}/compare/v${current}...v${target})`]),
    "",
    "## Resource schema changes",
    ...options.resources,
    "",
    "## Data source schema changes",
    ...options.dataSources,
    "",
    "## Upstream implementation/dependency changes",
    ...(options.files.length === 0
      ? ["- None listed; review release notes and the full comparison anyway."]
      : options.files.map((file) => `- ${file.status}: \`${file.filename}\``)),
    ...(options.truncated
      ? [
          "- WARNING: GitHub comparison reached its 300-file limit. Review the full comparison locally; this list is incomplete.",
        ]
      : []),
    "",
    "## Required review before claiming support",
    "- [ ] Read release notes and source changes, including entries with unchanged schemas.",
    "- [ ] Implement gaps and exercise changed validation/defaults/clearing/import/delete behavior through the real provider.",
    "- [ ] Update named lifecycle evidence and run the compatibility release gates on supported database backends.",
    "- [ ] Keep implementation fixes on a separate branch; the refresh branch is regenerated by automation.",
    "",
    "Generated by the provider refresh process; unchecked items are not evidence of completed validation.",
    "",
  ].join("\n");
}
