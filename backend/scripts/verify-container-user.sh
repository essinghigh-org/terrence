#!/usr/bin/env bash
# 22.12 — verify a running Terrence container executes as the shipped
# `appuser` (non-root), owns its tree, and can write to storage.
#
# Usage: verify-container-user.sh <container-name>
# Exit 0 = all checks pass.
# Exit 1 = any check failed (details on stderr).
# Exit 2 = usage error (no container name given).
set -u

CONTAINER="${1:-}"
if [[ -z "${CONTAINER}" ]]; then
  echo "usage: $0 <container-name>" >&2
  exit 2
fi

fail=0

check() {
  local label="$1"
  local result="$2"
  if [[ "${result}" == ok* ]]; then
    echo "ok   ${label}"
  else
    echo "FAIL ${label}: ${result}" >&2
    fail=1
  fi
}

# 1. Image declares the unprivileged user (name or numeric form).
user_decl=$(docker inspect "${CONTAINER}" --format '{{.Config.User}}' 2>/dev/null)
case "${user_decl}" in
  appuser|appuser:appuser|1001|1001:1001)
    check "image USER directive" "ok" ;;
  *)
    check "image USER directive" "Config.User='${user_decl}' (expected 'appuser' or uid 1001)" ;;
esac

# 2. The live process is non-root. Capture docker exec's own exit status so a
# failed exec is reported as an execution failure, not as a root process.
uid_line=$(docker exec "${CONTAINER}" sh -c 'id -u; id -g' 2>/dev/null)
exec_status=$?
if [[ "${exec_status}" -ne 0 ]]; then
  check "process runs non-root" "docker exec failed (status ${exec_status})"
else
  uid=$(printf '%s\n' "${uid_line}" | head -1)
  gid=$(printf '%s\n' "${uid_line}" | tail -1)
  if [[ -n "${uid}" ]] && [[ "${uid}" != "0" ]] && [[ -n "${gid}" ]] && [[ "${gid}" != "0" ]]; then
    check "process runs non-root" "ok (uid=${uid} gid=${gid})"
  else
    check "process runs non-root" "uid=${uid} gid=${gid} (both must be non-zero)"
  fi
fi

# 3. /app tree and storage are owned by the app user, not root.
tree_owner=$(docker exec "${CONTAINER}" sh -c 'stat -c "%U:%G" /app /app/backend/storage 2>/dev/null | sort -u' 2>/dev/null)
if [[ "${tree_owner}" == "appuser:appuser" ]]; then
  check "tree + storage ownership" "ok (appuser:appuser)"
else
  check "tree + storage ownership" "owners='${tree_owner}' (expected only 'appuser:appuser')"
fi

# 4. Storage is writable by the app user at runtime.
write_res=$(docker exec "${CONTAINER}" sh -c 'p=/app/backend/storage/.perm-verify-$$; touch "$p" && rm -f "$p" && echo writable || echo read-only' 2>/dev/null)
if [[ "${write_res}" == "writable" ]]; then
  check "storage writable" "ok"
else
  check "storage writable" "${write_res:-docker exec failed}"
fi

# 5. Storage contains no root-owned files (bind-mount trap on hosts).
root_owned=$(docker exec "${CONTAINER}" sh -c 'find /app/backend/storage -maxdepth 1 -user root -print -quit 2>/dev/null' 2>/dev/null)
if [[ -z "${root_owned}" ]]; then
  check "no root-owned storage entries" "ok"
else
  check "no root-owned storage entries" "found: ${root_owned}"
fi

if [[ "${fail}" -eq 1 ]]; then
  echo "RESULT: FAIL" >&2
  exit 1
fi
echo "RESULT: PASS"
