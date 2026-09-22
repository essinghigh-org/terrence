#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

# Last release commit that speaks HA protocol 1. Update this pin when the
# minimum compatible protocol advances.
protocol_1_fixture_sha="${HA_PROTOCOL_1_FIXTURE_SHA:-cd0037c6dcfc8532c7d4c1bf0ed52c503b41f534}"

root="$(git rev-parse --show-toplevel)"
base_dir="${RUNNER_TEMP:-/tmp}/terrence-ha-protocol1-$$"
storage_dir="${RUNNER_TEMP:-/tmp}/terrence-ha-storage-$$"
log_dir="${RUNNER_TEMP:-/tmp}/terrence-ha-logs-$$"
old_port=38181
new_port=38182
cluster_public_url="http://127.0.0.1:38180"
old_pid=""
new_pid=""
started_pid=""

cleanup_process() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  cleanup_process "$new_pid"
  cleanup_process "$old_pid"
  git -C "$root" worktree remove --force "$base_dir" >/dev/null 2>&1 || true
  rm -rf "$storage_dir" "$log_dir"
}
trap cleanup EXIT

mkdir -p "$storage_dir" "$log_dir"
if ! git -C "$root" cat-file -e "$protocol_1_fixture_sha^{commit}"; then
  echo "Pinned HA protocol-1 fixture is unavailable: $protocol_1_fixture_sha" >&2
  exit 1
fi
# The protocol-1 fixture predates explicit protocol columns; HA-3 deliberately
# interprets missing/null protocol metadata as protocol 1 during first upgrade.
git -C "$root" worktree add --detach "$base_dir" "$protocol_1_fixture_sha" >/dev/null
(
  cd "$base_dir"
  bun install --frozen-lockfile >/dev/null
)

base_version="$(jq -r '.version' "$base_dir/package.json")"
if [[ ! "$base_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  echo "Unable to parse base package version: $base_version" >&2
  exit 1
fi
next_version="${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1)).0"

common_env=(
  "DATABASE_URL=$DATABASE_URL"
  "TERRENCE_HA_ENABLED=true"
  "STORAGE_DIR=$storage_dir"
  "ENCRYPTION_PASSWORD=mixed-version-encryption-password-123456"
  "TERRENCE_TOKEN_HASH_SECRET=mixed-version-token-hash-secret-123456"
  "SIGNED_URL_SECRET=mixed-version-signed-url-secret-123456"
  "ADMIN_PASSWORD=mixed-version-admin-password-123456"
  "TERRENCE_RUN_SANDBOX=false"
  "TERRENCE_DISABLE_RESTART=1"
  "TERRENCE_DISABLE_WORKER=0"
  "NODE_ENV=test"
)

start_node() {
  local checkout="$1"
  local node_id="$2"
  local version="$3"
  local port="$4"
  local log="$5"

  (
    cd "$checkout/backend"
    exec env "${common_env[@]}" \
      "TERRENCE_NODE_ID=$node_id" \
      "BUILD_VERSION=$version" \
      "PUBLIC_URL=$cluster_public_url" \
      "PORT=$port" \
      "SYSTEM_API_PORT=$((port + 100))" \
      bun index.ts >"$log" 2>&1
  ) &
  started_pid=$!
}

wait_health() {
  local port="$1"
  local log="$2"
  local pid="$3"

  for _ in $(seq 1 160); do
    if curl --fail --silent "http://127.0.0.1:$port/healthz" >/dev/null; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log" >&2
      return 1
    fi
    sleep 0.25
  done

  cat "$log" >&2
  return 1
}

create_system_token() {
  (
    cd "$root/backend"
    env "${common_env[@]}" bun -e '
      const { createSystemApiToken } = await import("./src/lib/system-api");
      const created = await createSystemApiToken("HA mixed-version smoke", 1);
      process.stdout.write(created.token);
    '
  )
}

protocol_rows_json() {
  (
    cd "$root/backend"
    env DATABASE_URL="$DATABASE_URL" bun -e '
      const { SQL } = await import("bun");
      const client = new SQL(process.env.DATABASE_URL);
      try {
        const rows = await client.unsafe(
          "SELECT id, COALESCE(protocol_version, 1)::int AS protocol FROM control_plane_nodes WHERE id IN ($1, $2) ORDER BY id",
          ["ha-n-1", "ha-n"],
        );
        process.stdout.write(JSON.stringify(rows));
      } finally {
        await client.close();
      }
    '
  )
}

assert_system_readiness() {
  local system_port="$1"
  local node_id="$2"
  local token="$3"
  curl --fail --silent \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$system_port/api/v1/nodes/readiness" |
    jq -e --arg node_id "$node_id" '.data | any(.id == $node_id and .attributes.status == "OK")' >/dev/null
}

start_node "$base_dir" "ha-n-1" "$base_version" "$old_port" "$log_dir/old.log"
old_pid=$started_pid
wait_health "$old_port" "$log_dir/old.log" "$old_pid"

start_node "$root" "ha-n" "$next_version" "$new_port" "$log_dir/new.log"
new_pid=$started_pid
wait_health "$new_port" "$log_dir/new.log" "$new_pid"

# Protocol 1 must remain ready after protocol 2 applies its additive schema migration.
curl --fail --silent "http://127.0.0.1:$old_port/healthz" >/dev/null
curl --fail --silent "http://127.0.0.1:$new_port/healthz" >/dev/null

protocols="$(protocol_rows_json)"
if ! jq -e '
  length == 2 and
  (map({key: .id, value: .protocol}) | from_entries) == {"ha-n-1": 1, "ha-n": 2}
' <<<"$protocols" >/dev/null; then
  echo "Unexpected HA protocol registrations: $protocols" >&2
  exit 1
fi

system_token="$(create_system_token)"
assert_system_readiness "$((old_port + 100))" "ha-n-1" "$system_token"
assert_system_readiness "$((new_port + 100))" "ha-n" "$system_token"

echo "Mixed-version HA smoke passed: $protocol_1_fixture_sha ($base_version/protocol 1) and HEAD ($next_version/protocol 2)."
