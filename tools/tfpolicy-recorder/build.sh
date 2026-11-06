#!/usr/bin/env bash
# Build ONLY the recorder against an exact official public protocol revision.
# No Terraform engine source is compiled or patched by this script.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${1:?usage: build.sh OFFICIAL_TERRAFORM_GIT_CHECKOUT OUTPUT_BINARY}"
OUTPUT="${2:?output binary required}"
COMMIT=ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
[[ "$(git -C "$SOURCE" rev-parse "$COMMIT^{commit}")" == "$COMMIT" ]]
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Read committed blobs, not mutable working-tree files. Preserve the original
# module path to respect Go's internal import rule without vendoring the engine.
git -C "$SOURCE" archive "$COMMIT" LICENSE go.sum internal/policy/proto | tar -x -C "$WORK"
# Only generated protobuf transport definitions, not Terraform diagnostic helpers
# or engine implementation, belong to this adapter's dependency graph.
find "$WORK/internal/policy/proto" -type f ! -name '*.pb.go' ! -name '*.proto' -delete
cat > "$WORK/go.mod" <<'MOD'
module github.com/hashicorp/terraform

go 1.26.10

require (
 github.com/hashicorp/go-plugin v1.7.0
 google.golang.org/grpc v1.83.2
 google.golang.org/protobuf v1.36.11
)
MOD
mkdir -p "$WORK/internal/policy/terrence-recorder"
cp "$HERE"/*.go "$WORK/internal/policy/terrence-recorder/"
cp -R "$HERE/cmd" "$WORK/internal/policy/terrence-recorder/"
TEST_FLAGS=()
if [[ "${TFPOLICY_TEST_RACE:-0}" == 1 ]]; then TEST_FLAGS=(-race); fi
(cd "$WORK" && go test "${TEST_FLAGS[@]}" -mod=mod ./internal/policy/terrence-recorder && CGO_ENABLED=0 GOOS=linux go build -mod=readonly -trimpath -buildvcs=false -o "$OUTPUT" ./internal/policy/terrence-recorder/cmd/tfpolicy-recorder)
cp "$WORK/LICENSE" "${OUTPUT}.upstream-LICENSE"
cp "$WORK/go.mod" "${OUTPUT}.go.mod"
cp "$WORK/go.sum" "${OUTPUT}.go.sum"
printf 'upstream_commit=%s\n' "$COMMIT" > "${OUTPUT}.provenance"
go version >> "${OUTPUT}.provenance"
go version -m "$OUTPUT" >> "${OUTPUT}.provenance"
chmod 0555 "$OUTPUT"
sha256sum "$OUTPUT"
