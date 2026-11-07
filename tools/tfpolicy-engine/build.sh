#!/usr/bin/env bash
set -euo pipefail

# Build from committed upstream blobs and this reviewed patch, never a mutable
# source worktree. No proprietary executable is downloaded or bundled.
if [[ $# != 2 || "$1" != /* || "$2" != /* ]]; then
  echo "usage: build.sh /absolute/terraform/git /absolute/new-output-directory" >&2
  exit 2
fi
source_git="$1"
output_dir="$2"
source_commit=ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
patch_file="$script_dir/native-policy.patch"
if [[ -e "$output_dir" ]]; then
  echo "output directory already exists" >&2
  exit 2
fi
if [[ "$(go version | awk '{print $3}')" != go1.26.10 ]]; then
  echo "Go 1.26.10 is required for this pinned engine build" >&2
  exit 2
fi
if [[ "$(go env GOOS)" != linux ]]; then
  echo "strict native policy execution requires Linux" >&2
  exit 2
fi
git -C "$source_git" cat-file -e "$source_commit^{commit}"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/terrence-policy-engine.XXXXXXXX")"
trap 'rm -rf -- "$build_root"' EXIT
mkdir "$build_root/source" "$build_root/result"
git -C "$source_git" archive "$source_commit" | tar -x -C "$build_root/source"
git -C "$build_root/source" apply --check "$patch_file"
git -C "$build_root/source" apply "$patch_file"
patch_sha="$(sha256sum "$patch_file" | awk '{print $1}')"
(
  cd "$build_root/source"
  go mod verify
  go test ./internal/command ./internal/terraform ./internal/policy -run 'NativePolicy|Policy' -count=1
  CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags "-X github.com/hashicorp/terraform/version.dev=no -X github.com/hashicorp/terraform/internal/command.NativePolicyPatchSHA256=$patch_sha" \
    -o "$build_root/result/terraform" .
)
cp "$build_root/source/LICENSE" "$build_root/result/LICENSE"
go version -m "$build_root/result/terraform" > "$build_root/result/buildinfo.txt"
engine_sha="$(sha256sum "$build_root/result/terraform" | awk '{print $1}')"
platform="$(go env GOOS)_$(go env GOARCH)"
cat > "$build_root/result/provenance.json" <<JSON
{"schemaVersion":1,"contractVersion":1,"sourceCommit":"$source_commit","patchSha256":"$patch_sha","terraformVersion":"1.17.1","platform":"$platform","goVersion":"1.26.10","engineSha256":"$engine_sha","license":"BUSL-1.1","proprietaryRuntimeIncluded":false}
JSON
chmod 0500 "$build_root/result/terraform"
chmod 0400 "$build_root/result/LICENSE" "$build_root/result/buildinfo.txt" "$build_root/result/provenance.json"
mkdir -p -- "$(dirname -- "$output_dir")"
mv -- "$build_root/result" "$output_dir"
echo "$output_dir/terraform: $engine_sha"
