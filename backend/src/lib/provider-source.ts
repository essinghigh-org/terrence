const PROVIDER_SOURCE_ALIASES: Readonly<Record<string, string>> = {
  archive: "hashicorp/archive",
  aws: "hashicorp/aws",
  awscc: "hashicorp/awscc",
  azurerm: "hashicorp/azurerm",
  azuread: "hashicorp/azuread",
  boundary: "hashicorp/boundary",
  cloudflare: "cloudflare/cloudflare",
  cloudinit: "hashicorp/cloudinit",
  consul: "hashicorp/consul",
  external: "hashicorp/external",
  google: "hashicorp/google",
  "google-beta": "hashicorp/google-beta",
  helm: "hashicorp/helm",
  http: "hashicorp/http",
  github: "integrations/github",
  kubernetes: "hashicorp/kubernetes",
  local: "hashicorp/local",
  nomad: "hashicorp/nomad",
  null: "hashicorp/null",
  random: "hashicorp/random",
  template: "hashicorp/template",
  tfe: "hashicorp/tfe",
  time: "hashicorp/time",
  tls: "hashicorp/tls",
  vault: "hashicorp/vault",
};

const PROVIDER_PART = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const REGISTRY_HOSTS = new Set(["registry.terraform.io", "registry.opentofu.org"]);

/**
 * Convert a Terraform provider source, registry provider id, or supported
 * bare provider label to the canonical namespace/name form used by the
 * provider icon service. Bare labels are resolved only through the explicit
 * alias map: a missing namespace must never silently become hashicorp/<name>.
 */
function normalizeBareProvider(parts: readonly string[]): string | null {
  const bare = parts[0]?.toLowerCase() ?? "";
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_SOURCE_ALIASES, bare)) return null;
  return PROVIDER_SOURCE_ALIASES[bare] ?? null;
}

function normalizeQualifiedProvider(parts: readonly string[]): string | null {
  const registryHost = parts[0]?.toLowerCase() ?? "";
  const sourceParts = parts.length === 3 && REGISTRY_HOSTS.has(registryHost)
    ? parts.slice(1)
    : parts;
  if (sourceParts.length !== 2) return null;
  const namespace = sourceParts[0] ?? "";
  const name = sourceParts[1] ?? "";
  if (!PROVIDER_PART.test(namespace) || !PROVIDER_PART.test(name)) return null;
  return `${namespace.toLowerCase()}/${name.toLowerCase()}`;
}

export function normalizeProviderSource(providerName: string | null | undefined): string | null {
  if (typeof providerName !== "string") return null;
  const trimmed = providerName.trim();
  if (trimmed === "") return null;

  const parts = trimmed.split("/");
  if (parts.some((part): boolean => part === "")) return null;
  return parts.length === 1
    ? normalizeBareProvider(parts)
    : normalizeQualifiedProvider(parts);
}
