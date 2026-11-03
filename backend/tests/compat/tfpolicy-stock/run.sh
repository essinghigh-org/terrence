#!/usr/bin/env bash
# Run only in an authorized CI environment permitting plugin sockets.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
VERSION=1.17.1
COMMIT=ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
cd "$WORK"
curl --fail --silent --show-error --location "https://releases.hashicorp.com/terraform/$VERSION/terraform_${VERSION}_linux_amd64.zip" -o terraform.zip
curl --fail --silent --show-error --location "https://releases.hashicorp.com/terraform/$VERSION/terraform_${VERSION}_SHA256SUMS" -o sums
EXPECTED="$(awk '$2=="terraform_1.17.1_linux_amd64.zip" {print $1}' sums)"
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]
printf '%s  terraform.zip\n' "$EXPECTED" | sha256sum -c -
unzip -q terraform.zip -d bin
# Compile our mock/recorder against the exact public source protocol. This is
# a test executable, not a modified Terraform binary or redistributed runtime.
git clone --filter=blob:none --no-checkout https://github.com/hashicorp/terraform.git source
git -C source checkout --detach "$COMMIT"
[[ "$(git -C source rev-parse HEAD)" == "$COMMIT" ]]
cp -R "$HERE/live-source/recordingproxy" source/internal/policy/
(cd source && go test ./internal/policy/recordingproxy && go build -o "$WORK/tfpolicy-harness" ./internal/policy/recordingproxy/cmd/tfpolicy-harness)
python3 "$HERE/live_harness.py" "$WORK/bin/terraform" "$WORK/tfpolicy-harness"
