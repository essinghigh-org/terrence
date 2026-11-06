#!/usr/bin/env bash
# Compile only this test protocol fixture, never a patched Terraform engine.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${1:?usage: build-fixture.sh OFFICIAL_TERRAFORM_GIT_CHECKOUT OUTPUT_BINARY}"
OUTPUT="${2:?output binary required}"
COMMIT=ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
[[ "$(git -C "$SOURCE" rev-parse "$COMMIT^{commit}")" == "$COMMIT" ]]
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$SOURCE" archive "$COMMIT" LICENSE go.sum internal/policy/proto | tar -x -C "$WORK"
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
mkdir -p "$WORK/internal/policy/integration-fixture"
cp "$HERE/fixture/main.go.in" "$WORK/internal/policy/integration-fixture/main.go"
(cd "$WORK" && CGO_ENABLED=0 GOOS=linux go build -mod=mod -trimpath -buildvcs=false -o "$OUTPUT" ./internal/policy/integration-fixture)
chmod 0555 "$OUTPUT"
cp "$WORK/LICENSE" "${OUTPUT}.upstream-LICENSE"
sha256sum "$OUTPUT"
