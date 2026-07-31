#!/bin/sh
# Build the static Landlock runner helper used to sandbox Terraform/OpenTofu runs.
# Requires gcc + libc6-dev (Debian/Ubuntu: apt-get install gcc libc6-dev).
set -eu
cd "$(dirname "$0")"
gcc -static -O2 -Wall -Wextra -o landlock-runner landlock-runner.c
./landlock-runner --probe
echo "built: $(pwd)/landlock-runner"
