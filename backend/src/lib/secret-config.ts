export const deploymentSecretNames = ["SIGNED_URL_SECRET", "TERRENCE_TOKEN_HASH_SECRET", "ENCRYPTION_PASSWORD"] as const;
export type DeploymentSecretName = (typeof deploymentSecretNames)[number];
export type SecretConfiguration = Readonly<Record<DeploymentSecretName, string | undefined>>;

export function parseDeploymentSecret(name: DeploymentSecretName, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = name === "ENCRYPTION_PASSWORD" ? raw : raw.trim();
  const minimum = name === "ENCRYPTION_PASSWORD" ? 1 : 32;
  const length = name === "SIGNED_URL_SECRET" ? value.length : Buffer.byteLength(value, "utf8");
  if (length < minimum || length > 65536 || value.includes("\u0000")) {
    throw new Error(`${name} must be a non-empty secret meeting its documented length bounds`);
  }
  return value;
}

export function parseSecretConfiguration(environment: Readonly<Record<string, string | undefined>>): SecretConfiguration {
  return Object.freeze({
    SIGNED_URL_SECRET: parseDeploymentSecret("SIGNED_URL_SECRET", environment["SIGNED_URL_SECRET"]),
    TERRENCE_TOKEN_HASH_SECRET: parseDeploymentSecret("TERRENCE_TOKEN_HASH_SECRET", environment["TERRENCE_TOKEN_HASH_SECRET"]),
    ENCRYPTION_PASSWORD: parseDeploymentSecret("ENCRYPTION_PASSWORD", environment["ENCRYPTION_PASSWORD"]),
  });
}
