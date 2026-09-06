/** Inputs still parsed by their owning subsystem. Keep names explicit so
 * adding a deployment knob requires updating the startup contract. */
export const subsystemEnvironmentNames = [
  "ADMIN_EMAIL", "ADMIN_ORGANIZATION", "ADMIN_PASSWORD", "ADMIN_USERNAME",
  "BITBUCKET_WEBHOOK_SECRET", "BUILD_SHA", "BUILD_VERSION", "DATABASE_URL",
  "ENCRYPTION_PASSWORD", "GH_TOKEN", "GITHUB_API_URL", "GITHUB_APP_API_URL",
  "GITHUB_APP_HTTP_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG",
  "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITLAB_WEBHOOK_SECRET", "GPG_BINARY_PATH",
  "IACT_TOKEN", "INFRACOST_BINARY", "INFRACOST_VERSION", "OPA_BINARY_PATH", "OPA_VERSION",
  "SENTINEL_BINARY_PATH", "SIGNED_URL_SECRET", "SIMULATED_ASSESSMENT_JSON",
  "SIMULATED_ASSESSMENT_SCHEMA", "SIMULATED_PLAN_JSON", "TERRAFORM_CONFIG_INSPECT_PATH",
  "TERRAFORM_TEST_BINARY_PATH", "TERRENCE_AGENT_UPDATE_SHA256", "TERRENCE_AGENT_UPDATE_URL",
  "TERRENCE_AGENT_UPDATE_VERSION", "TERRENCE_BINARY_CACHE_DIR", "TERRENCE_COMPATIBILITY_VERSION",
  "TERRENCE_LANDLOCK_RUNNER", "TERRENCE_NODE_ADDRESS", "TERRENCE_NODE_ID", "TERRENCE_NODE_STATUS",
  "TERRENCE_SANDBOX_EXTRA_RW_PATHS", "TERRENCE_SANDBOX_MIN_ABI", "TERRENCE_STACK_IAC_BINARY",
  "TERRENCE_STACK_IAC_VERSION", "TERRENCE_TFE_COMPATIBILITY_VERSION", "TERRENCE_TFP_API_VERSION",
  "TERRENCE_TOKEN_HASH_SECRET", "TERRENCE_VERSION_CACHE_FILE", "TERRENCE_SYSLOG_TARGET",
  "TERRENCE_RESOURCE_BUDGETS_JSON",
  "TERRENCE_PROPERTY_CASES",
] as const;

const ownedPrefixes = ["TERRENCE_", "SYSTEM_API_", "RATE_LIMIT_", "AVATAR_CACHE_", "HEALTH_ASSESSMENT_", "GITHUB_APP_", "INFRACOST_", "CLI_TOKEN_", "LOG_CAPABILITY_"];

export function assertKnownEnvironmentNames(
  environment: Readonly<Record<string, string | undefined>>,
  parsed: Readonly<Record<string, unknown>>,
): void {
  const accepted = new Set<string>([...Object.keys(parsed), ...subsystemEnvironmentNames]);
  for (const name of Object.keys(environment)) {
    const prefix = ownedPrefixes.find((candidate): boolean => name.startsWith(candidate));
    if (prefix !== undefined && !accepted.has(name)) {
      // Do not echo the entire unknown name: misplaced credentials can
      // appear in either the name or the value of a malformed environment.
      throw new Error(`Unknown ${prefix} configuration name; consult the configuration reference`);
    }
  }
}
