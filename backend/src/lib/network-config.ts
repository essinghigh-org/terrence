import { isIP } from "node:net";

export type NetworkConfiguration = Readonly<Record<
  "TERRENCE_TRUSTED_PROXY_CIDRS" | "TERRENCE_OUTBOUND_ALLOW_CIDRS" | "TERRENCE_OUTBOUND_ALLOW_HOSTS",
  readonly string[]
>>;

export function validConfiguredCidr(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  return address !== undefined && isIP(address) === 4 && extra.length === 0
    && (prefix === undefined || /^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix));
}

function configuredList(raw: string | undefined, validate: (value: string) => boolean): readonly string[] {
  if (raw === undefined || raw === "") return Object.freeze([]);
  const values = raw.split(",").map((value): string => value.trim());
  if (values.length > 256 || values.some((value): boolean => !validate(value))) {
    throw new Error("Invalid network allowlist configuration; expected at most 256 supported entries");
  }
  return Object.freeze([...new Set(values)]);
}

export function parseNetworkConfiguration(environment: Readonly<Record<string, string | undefined>>): NetworkConfiguration {
  const hosts = configuredList(environment["TERRENCE_OUTBOUND_ALLOW_HOSTS"], (value): boolean => {
    return value.length <= 253 && /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.?$/.test(value);
  }).map((value): string => value.toLowerCase().replace(/\.$/, ""));
  return Object.freeze({
    TERRENCE_TRUSTED_PROXY_CIDRS: configuredList(environment["TERRENCE_TRUSTED_PROXY_CIDRS"], validConfiguredCidr),
    TERRENCE_OUTBOUND_ALLOW_CIDRS: configuredList(environment["TERRENCE_OUTBOUND_ALLOW_CIDRS"], validConfiguredCidr),
    TERRENCE_OUTBOUND_ALLOW_HOSTS: Object.freeze(hosts),
  });
}
