FROM oven/bun:1 AS builder
WORKDIR /app

# Copy the entire monorepo
COPY . .

# Install dependencies (workspaces)
RUN bun install

# Build frontend
WORKDIR /app/frontend
RUN bun run build

# Compile the static Landlock runner (needs a C toolchain; the final image
# does not ship one)
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && gcc -static -O2 -Wall -Wextra -o /app/backend/bin/landlock-runner \
        /app/backend/bin/landlock-runner.c \
    && rm -rf /var/lib/apt/lists/* \
    && /app/backend/bin/landlock-runner --probe

# Final stage
FROM oven/bun:1-slim
ARG TARGETARCH=amd64
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/backend/storage \
    DATABASE_URL=file:/app/backend/storage/terrence.db \
    INFRACOST_ENABLED=false \
    INFRACOST_API_KEY=""

# Install system dependencies needed for OpenTofu & Terraform
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    tar \
    git \
    coreutils \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Apprise (notification delivery engine; ~100+ services supported)
RUN pip3 install --no-cache-dir apprise


# Install Infracost with SHA256 verification
ENV INFRACOST_VERSION=0.10.45
RUN ARCH=${TARGETARCH:-amd64} && \
    curl -fLo infracost.tar.gz "https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-${ARCH}.tar.gz" && \
    curl -fLo infracost_SHA256SUMS "https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-${ARCH}.tar.gz.sha256" && \
    grep "$(sha256sum infracost.tar.gz | cut -d' ' -f1)" infracost_SHA256SUMS && \
    tar -xzf infracost.tar.gz -C /tmp && \
    mv /tmp/infracost-linux-${ARCH} /usr/local/bin/infracost && \
    chmod +x /usr/local/bin/infracost && \
    rm infracost.tar.gz infracost_SHA256SUMS

# Copy monorepo files for backend
COPY bun.lock ./
COPY package.json ./
COPY backend/package.json ./backend/
COPY backend/drizzle.config.ts ./backend/
COPY backend/drizzle ./backend/drizzle
COPY backend/index.ts ./backend/
COPY backend/src ./backend/src
COPY --from=builder /app/backend/bin/landlock-runner ./backend/bin/landlock-runner

# Install production dependencies for backend
WORKDIR /app/backend
RUN bun install --production

# Copy built frontend static assets
COPY --from=builder /app/frontend/dist /app/frontend/dist

# Create storage directory & unprivileged user. The Landlock run sandbox needs
# no privileges (no chroot, no capabilities), so the whole app runs unprivileged.
RUN mkdir -p /app/backend/storage && \
    useradd -m appuser && \
    chown -R appuser:appuser /app

VOLUME ["/app/backend/storage"]

USER appuser

# Expose the API/UI
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/readyz" > /dev/null || exit 1

CMD ["bun", "run", "index.ts"]
