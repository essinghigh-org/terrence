import { sanitizeAuditValue } from "./audit-trail";

export type BlueprintDefinition = Readonly<{
  id: string;
  version: number;
  name: string;
  description: string;
  parameters: readonly Readonly<{ name: string; required: boolean; description: string }>[];
  resultingObjects: readonly string[];
}>;

/** Small, reviewable starting points for workspace setup. */
export const WORKSPACE_BLUEPRINTS: readonly BlueprintDefinition[] = [
  {
    id: "remote-vcs-workspace",
    version: 1,
    name: "Remote VCS workspace",
    description: "A remote execution workspace with a repository link and explicit variable-set references.",
    parameters: [
      { name: "name", required: true, description: "Workspace display name" },
      { name: "project", required: false, description: "Existing project name" },
      { name: "repository", required: true, description: "Repository identifier, for example org/repository" },
      { name: "branch", required: false, description: "Branch name; defaults to the repository default" },
      { name: "variable-set-ids", required: false, description: "Approved variable-set IDs; values are never embedded" },
    ],
    resultingObjects: ["workspace", "repository-link", "variable-set attachments"],
  },
  {
    id: "policy-ready-workspace",
    version: 1,
    name: "Policy-ready workspace",
    description: "A workspace with policy attachments staged for an explicit administrator rollout.",
    parameters: [
      { name: "name", required: true, description: "Workspace display name" },
      { name: "project", required: false, description: "Existing project name" },
      { name: "policy-set-ids", required: true, description: "Existing policy-set IDs" },
      { name: "enforcement", required: false, description: "advisory, soft-mandatory, or hard-mandatory" },
    ],
    resultingObjects: ["workspace", "policy-set attachments"],
  },
  {
    id: "drift-monitoring-workspace",
    version: 1,
    name: "Drift monitoring workspace",
    description: "A workspace with continuous assessment enabled and notifications left for explicit configuration.",
    parameters: [
      { name: "name", required: true, description: "Workspace display name" },
      { name: "project", required: false, description: "Existing project name" },
      { name: "repository", required: false, description: "Optional repository identifier" },
      { name: "assessment-interval", required: false, description: "Existing assessment interval accepted by the workspace API" },
    ],
    resultingObjects: ["workspace", "assessment configuration"],
  },
];

export type PolicyPackDefinition = Readonly<{
  id: string;
  version: number;
  name: string;
  mode: "advisory";
  description: string;
  rules: readonly Readonly<{ id: string; title: string; logic: string; blindSpot: string }>[];
}>;

/** Opinionated defaults are advisory until an organization explicitly enables enforcement. */
export const OPINIONATED_POLICY_PACKS: readonly PolicyPackDefinition[] = [
  {
    id: "safe-lifecycle",
    version: 1,
    name: "Safe lifecycle",
    mode: "advisory",
    description: "Flags destructive changes for review when plan data exposes the affected resources.",
    rules: [{
      id: "destructive-change-review",
      title: "Review destructive changes",
      logic: "deny when the plan reports one or more resource destructions",
      blindSpot: "Unknown provider actions and opaque provider output remain unknown.",
    }],
  },
  {
    id: "required-tags",
    version: 1,
    name: "Required tags",
    mode: "advisory",
    description: "Checks visible resource tags without claiming provider-wide compliance.",
    rules: [{
      id: "owner-tag",
      title: "Require an owner tag",
      logic: "unknown when a resource schema does not expose tags; deny when tags are present without owner",
      blindSpot: "Provider-specific tag inheritance and generated resources are not inspected.",
    }],
  },
];

export function normalizedSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

/** Stable Terraform identifier; display-name changes do not change imports. */
export function stableConfigName(value: string, fallback = "workspace"): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const result = normalized === "" ? fallback : normalized;
  return /^[0-9]/.test(result) ? `workspace_${result}` : result;
}

function hclString(value: string): string {
  return JSON.stringify(value);
}

export type WorkspaceAdoptionExport = Readonly<{
  organizationName: string;
  workspace: Readonly<{
    id: string;
    name: string;
    projectName: string | null;
    executionMode: string;
    terraformVersion: string | null;
    repository: string | null;
  }>;
  variableSets: readonly Readonly<{ id: string; name: string }>[];
  policySets: readonly Readonly<{ id: string; name: string }>[];
}>;

/**
 * Render only reviewable Terraform/provider configuration. Secret values are
 * intentionally represented by external variables and unsupported fields are
 * listed as comments instead of being silently dropped.
 */
export function renderWorkspaceAdoptionHcl(input: WorkspaceAdoptionExport): string {
  const workspaceName = stableConfigName(input.workspace.name);
  const lines: string[] = [
    "# Terrence adoption export v1",
    "# Generated from authorized metadata. Secret values are supplied separately.",
    `# organization: ${input.organizationName}`,
    "",
    'terraform {\n  required_providers {\n    tfe = {\n      source = "hashicorp/tfe"\n    }\n  }\n}',
    "",
    `resource \"tfe_workspace\" ${hclString(workspaceName)} {`,
    `  name         = ${hclString(input.workspace.name)}`,
    `  organization = var.organization_name`,
    `  execution_mode = ${hclString(input.workspace.executionMode)}`,
    ...(input.workspace.terraformVersion === null ? [] : [`  terraform_version = ${hclString(input.workspace.terraformVersion)}`]),
    ...(input.workspace.projectName === null ? [] : [`  # project: ${input.workspace.projectName}`]),
    ...(input.workspace.repository === null ? [] : [`  # vcs-repository: ${input.workspace.repository}`]),
    "}",
    "",
    'variable "organization_name" {',
    `  description = ${hclString("Terrence organization name")}`,
    "  type        = string",
    "}",
    "",
    `# import { to = tfe_workspace.${workspaceName} id = ${hclString(input.workspace.id)} }`,
  ];
  if (input.variableSets.length > 0) {
    lines.push("", "# Existing variable-set attachments (values intentionally omitted)");
    for (const variableSet of [...input.variableSets].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`# variable-set ${variableSet.name} (${variableSet.id})`, `# import { to = tfe_workspace_variable_set.${stableConfigName(variableSet.name, "variable_set")} id = ${hclString(variableSet.id)} }`);
    }
  }
  if (input.policySets.length > 0) {
    lines.push("", "# Existing policy-set attachments; review enforcement before applying");
    for (const policySet of [...input.policySets].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`# policy-set ${policySet.name} (${policySet.id})`);
    }
  }
  lines.push("", "# Unsupported or operator-reviewed fields:", "# - credentials and sensitive variable values", "# - provider-side notification delivery state", "# - state snapshots and run history");
  return `${lines.join("\n")}\n`;
}

/** Keep webhook payload previews safe even when a provider adds new fields. */
export function redactedWebhookPayload(payload: unknown): Record<string, unknown> {
  const sanitized = sanitizeAuditValue(payload);
  return sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

export function webhookRepository(payload: Readonly<Record<string, unknown>>): string | null {
  const repository = payload["repository"];
  if (repository !== null && typeof repository === "object" && !Array.isArray(repository)) {
    const value = (repository as Record<string, unknown>)["full_name"] ?? (repository as Record<string, unknown>)["path_with_namespace"];
    if (typeof value === "string" && value !== "") return value;
  }
  const project = payload["project"];
  if (project !== null && typeof project === "object" && !Array.isArray(project)) {
    const value = (project as Record<string, unknown>)["path_with_namespace"];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}
