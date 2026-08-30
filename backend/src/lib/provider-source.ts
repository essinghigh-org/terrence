export const DEFAULT_PROVIDER_REGISTRY_HOST = "registry.terraform.io";

const PROVIDER_PART = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const HOST_PART = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

export type ProviderSource = Readonly<{
  source: string;
  hostname: string;
  namespace: string;
  name: string;
}>;

function parseProviderAddress(trimmed: string): ProviderSource | null {
  if (trimmed === "") return null;

  const parts = trimmed.split("/");
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((part): boolean => part === "")) return null;

  const hasExplicitHostname = parts.length === 3;
  const hostname = (hasExplicitHostname ? parts[0] : DEFAULT_PROVIDER_REGISTRY_HOST) ?? "";
  const namespace = (hasExplicitHostname ? parts[1] : parts[0]) ?? "";
  const name = (hasExplicitHostname ? parts[2] : parts[1]) ?? "";
  if (!HOST_PART.test(hostname) || !PROVIDER_PART.test(namespace) || !PROVIDER_PART.test(name)) return null;

  const canonicalHostname = hostname.toLowerCase();
  const canonicalNamespace = namespace.toLowerCase();
  const canonicalName = name.toLowerCase();
  return {
    source: hasExplicitHostname
      ? `${canonicalHostname}/${canonicalNamespace}/${canonicalName}`
      : `${canonicalNamespace}/${canonicalName}`,
    hostname: canonicalHostname,
    namespace: canonicalNamespace,
    name: canonicalName,
  };
}

/**
 * Parse a Terraform provider source address without inventing a namespace.
 * Two-part addresses use Terraform's documented default registry, while
 * three-part addresses retain their explicit hostname for routing decisions.
 */
export function parseProviderSource(providerName: string | null | undefined): ProviderSource | null {
  if (typeof providerName !== "string") return null;
  return parseProviderAddress(providerName.trim());
}

export function normalizeProviderSource(providerName: string | null | undefined): string | null {
  return parseProviderSource(providerName)?.source ?? null;
}
