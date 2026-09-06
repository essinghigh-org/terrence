export type IntegrationConfiguration = Readonly<
  Record<"GITHUB_API_URL" | "GITHUB_APP_API_URL", string>
  & Record<"GITHUB_APP_HTTP_URL", string | null>
  & Record<"TERRENCE_AGENT_UPDATE_VERSION" | "TERRENCE_AGENT_UPDATE_URL" | "TERRENCE_AGENT_UPDATE_SHA256", string | null>
  & Record<"TERRENCE_NODE_STATUS", "active" | "draining" | "maintenance">
>;

function httpBase(raw: string | undefined, name: string, fallback: string | null): string | null {
  if (raw === undefined) return fallback;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "" || raw.trim() === "") throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
}

type AgentUpdateConfiguration = Pick<IntegrationConfiguration, "TERRENCE_AGENT_UPDATE_VERSION" | "TERRENCE_AGENT_UPDATE_URL" | "TERRENCE_AGENT_UPDATE_SHA256">;

function agentUpdate(environment: Readonly<Record<string, string | undefined>>): AgentUpdateConfiguration {
  const version = environment["TERRENCE_AGENT_UPDATE_VERSION"];
  const url = environment["TERRENCE_AGENT_UPDATE_URL"];
  const sha256 = environment["TERRENCE_AGENT_UPDATE_SHA256"];
  if (version === undefined && url === undefined && sha256 === undefined) {
    return { TERRENCE_AGENT_UPDATE_VERSION: null, TERRENCE_AGENT_UPDATE_URL: null, TERRENCE_AGENT_UPDATE_SHA256: null };
  }
  if (version === undefined || url === undefined || sha256 === undefined) throw new Error("Agent update version, URL, and SHA256 must be configured together");
  if (!/^[a-zA-Z0-9._+-]{1,128}$/.test(version) || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new Error("Invalid agent update version or SHA256 configuration");
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") throw new Error();
  } catch { throw new Error("Agent update URL must be HTTP(S) without credentials or fragment"); }
  return { TERRENCE_AGENT_UPDATE_VERSION: version, TERRENCE_AGENT_UPDATE_URL: url, TERRENCE_AGENT_UPDATE_SHA256: sha256.toLowerCase() };
}

export function parseIntegrationConfiguration(environment: Readonly<Record<string, string | undefined>>): IntegrationConfiguration {
  const status = (environment["TERRENCE_NODE_STATUS"] ?? "active").toLowerCase();
  if (status !== "active" && status !== "draining" && status !== "maintenance") throw new Error("TERRENCE_NODE_STATUS must be active, draining, or maintenance");
  const general = httpBase(environment["GITHUB_API_URL"], "GITHUB_API_URL", "https://api.github.com") ?? "https://api.github.com";
  return Object.freeze({
    ...agentUpdate(environment),
    TERRENCE_NODE_STATUS: status,
    GITHUB_API_URL: general,
    GITHUB_APP_API_URL: httpBase(environment["GITHUB_APP_API_URL"], "GITHUB_APP_API_URL", general) ?? general,
    // Null preserves the absence of an explicit private-host exception for avatars.
    GITHUB_APP_HTTP_URL: httpBase(environment["GITHUB_APP_HTTP_URL"], "GITHUB_APP_HTTP_URL", null),
  });
}
