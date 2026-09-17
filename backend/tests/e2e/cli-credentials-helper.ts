import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLI_CREDENTIALS_HELPER_CONFIG = `credentials_helper "terrence-e2e" {}
`;

const HELPER_SCRIPT = [
  "#!/bin/sh",
  "set -eu",
  'verb="${1:-}"',
  'case "$verb" in',
  "  get)",
  '    token="${TERRENCE_E2E_CLI_TOKEN:-}"',
  '    case "$token" in',
  `      ""|*[!A-Za-z0-9_-]*) printf '{}\\n'; exit 0 ;;`,
  "    esac",
  `    printf '{"token":"%s"}\\n' "$token"`,
  "    ;;",
  "  store|forget)",
  "    # E2E credentials are ephemeral and environment-backed; nothing is persisted.",
  '    if [ "$verb" = "store" ]; then cat >/dev/null; fi',
  "    ;;",
  "  *)",
  `    printf 'unsupported credentials-helper verb: %s\\n' "$verb" >&2`,
  "    exit 1",
  "    ;;",
  "esac",
  "",
].join("\n");

/** Install both Terraform and OpenTofu helper executable names under an isolated HOME. */
export async function installCliCredentialsHelper(homeDir: string): Promise<void> {
  const pluginDir = join(homeDir, ".terraform.d", "plugins");
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(pluginDir, "terraform-credentials-terrence-e2e"), HELPER_SCRIPT, { mode: 0o700 }),
    writeFile(join(pluginDir, "tofu-credentials-terrence-e2e"), HELPER_SCRIPT, { mode: 0o700 }),
  ]);
}
