# Terrence container image.
#
# Builder: oven/bun:1 (byte-for-byte the bun that owns the committed bun.lock).
# Runtime: Chainguard Wolfi (glibc) — see below for why.
#
# Runtime base rationale (validated by prototype builds during the swap):
#   - Near-zero CVEs out of the box: the previous Debian oven/bun:1-slim
#     stage carried 145+ OS-package vulns (16 CRITICAL) with no published fix.
#     Wolfi ships hardened packages (built from source, signature-verified,
#     SLSA-buildable, cgr.dev SBOMs). Scanned image: 0 findings.
#   - ~58% smaller: 173 MB (Debian) -> ~73 MB (Wolfi).
#   - glibc runtime: matches Debian ABI, so on-demand tofu/terraform/infracost/
#     opa Go binaries and the static C landlock runner behave identically
#     (musl-Alpine needed extra libstdc++/libgcc handling and is not used here).
#   - apk ships bun, git, unzip, wget, curl, ca-certificates-bundle as first-class
#     packages, so there is no manual Bun tarball and no external downloader to
#     hand-roll for the runtime toolchain.
#   - Runs as uid 65532 (nonroot) by default, matching the app's unprivileged
#     Landlock sandbox model (no chroot, no capabilities).
#
# The runtime stage layout EXACTLY mirrors the pre-Wolfi layout so the workspace
# install resolves identically: root package.json + bun.lock (workspace context),
# backend only (NOT frontend — frontend dev tooling vite/rolldown/tsx would leak
# esbuild and add CVEs), then bun install --production --frozen-lockfile from
# /app/backend. This is what keeps frozen-lockfile succeeding and esbuild out.

# terraform-config-inspect is feature-complete but does not publish release
# binaries, so build the pinned upstream revision once and keep Go out of the
# runtime image.
FROM golang:1.26-bookworm AS config-inspect-builder
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/hashicorp/terraform-config-inspect@v0.0.0-20260709150029-2fb54c236733

# ---------- Build stage: Bun backend workspaces + frontend + static landlock ---
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy the entire monorepo
COPY . .

# Install dependencies (workspaces)
RUN bun install --frozen-lockfile

# Build frontend
WORKDIR /app/frontend
RUN bun run build

# Compile the static Landlock runner (needs a C toolchain; the final image
# does not ship one). Static glibc binary -> runs identically on any base.
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && gcc -static -O2 -Wall -Wextra -o /app/backend/bin/landlock-runner \
        /app/backend/bin/landlock-runner.c \
    && rm -rf /var/lib/apt/lists/* \
    && /app/backend/bin/landlock-runner --probe

# ---------- Runtime: Chainguard Wolfi (glibc, near-zero CVE) ----------
# Base pinned to an immutable digest (reviewed/immutable supply chain).
# Tag at pin time: cgr.dev/chainguard/wolfi-base:latest. Bump deliberately
# after reviewing what changed in the new tag (pin the new digest).
FROM cgr.dev/chainguard/wolfi-base@sha256:30f03343947c7ae3581fda727a6e2aa7b8ce7009b7bfc2ab8d5c9483ace5812f
# Pin the full -rN revision so apk exact-matches; bump together with bun bumps.
ARG BUN_VERSION=1.3.14-r3
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/backend/storage \
    INFRACOST_ENABLED=false \
    INFRACOST_VERSION=0.10.45

# wolfi-base ships busybox (tar/cp/which), glibc, apk and ca-certificates-bundle.
# Add the external tools the worker shells out to at runtime. Bun comes from apk
# (pinned) — world-executable /usr/bin/bun, so the healthcheck works without
# a dedicated user-home install (the OLD alpine/Debian /root/.bun healthcheck bug
# came from a curl-installed bun living under an untraversable /root).
#
# Infracost is intentionally NOT baked into the image: it is installed on demand
# at runtime into <storage>/binaries/infracost/<version>/ (digest-verified) by
# backend/src/lib/infracost-bin.ts, selected by INFRACOST_VERSION. Baking it was
# the single remaining CVE surface in the image and forced a rebuild to bump the
# version; managing it like tofu/terraform removes both.
RUN apk add --no-cache \
        git \
        "bun=${BUN_VERSION}" \
        unzip \
        wget \
        curl \
        ca-certificates-bundle \
    && git config --global init.defaultBranch main 2>/dev/null || true

# Workspace root + backend ONLY (no frontend -> no esbuild/vite/rolldown dev
# tooling). Mirrors the previous runtime COPY set exactly.
COPY bun.lock ./
COPY package.json ./
COPY backend/package.json ./backend/
COPY backend/drizzle.config.ts ./backend/
COPY backend/drizzle ./backend/drizzle
COPY backend/index.ts ./backend/
COPY backend/src ./backend/src

# landlock-runner is compiled to a static glibc binary in the builder stage.
COPY --from=builder /app/backend/bin/landlock-runner ./backend/bin/landlock-runner
COPY --from=config-inspect-builder /out/terraform-config-inspect ./backend/bin/terraform-config-inspect

# Install production dependencies for backend, inside the workspace context,
# exactly as before. Frozen-lockfile resolves because root package.json
# (workspaces) + bun.lock are present and the frontend is absent.
WORKDIR /app/backend
RUN bun install --production --frozen-lockfile && \
    rm -rf /root/.bun/install/cache 2>/dev/null || true

# Copy built frontend static assets
COPY --from=builder /app/frontend/dist /app/frontend/dist

# Create storage directory. Wolfi images run as uid 65532 (nonroot); the Landlock
# sandbox needs no capabilities, so keep that user and grant it only the storage
# dir.
RUN mkdir -p /app/backend/storage && \
    chown -R 65532:65532 /app/backend/storage

VOLUME ["/app/backend/storage"]

# Backend is the app entry; run from /app/backend so `bun run index.ts` resolves
# the backend entry, not the root stub.
WORKDIR /app/backend

USER 65532:65532

# Expose the API/UI
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD /usr/bin/bun -e 'fetch("http://127.0.0.1:" + (process.env.PORT || "3000") + "/readyz").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'

CMD ["/usr/bin/bun", "run", "index.ts"]
