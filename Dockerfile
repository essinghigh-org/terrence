FROM oven/bun:1 AS builder
WORKDIR /app

# Copy the entire monorepo
COPY . .

# Install dependencies (workspaces)
RUN bun install

# Build frontend
WORKDIR /app/frontend
RUN bun run build

# Final stage
FROM oven/bun:1-slim
ARG TARGETARCH=amd64
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/backend/storage \
    DATABASE_URL=file:/app/backend/storage/terrence.db

# Install system dependencies needed for OpenTofu & Terraform
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    tar \
    git \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

# Install OpenTofu with SHA256 verification
ENV TOFU_VERSION=1.7.2
RUN ARCH=${TARGETARCH:-amd64} && \
    curl -fLo tofu.zip "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${ARCH}.zip" && \
    curl -fLo tofu_SHA256SUMS "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" && \
    grep "tofu_${TOFU_VERSION}_linux_${ARCH}.zip" tofu_SHA256SUMS | sha256sum -c - && \
    unzip tofu.zip -d /usr/local/bin && \
    rm tofu.zip tofu_SHA256SUMS && \
    chmod +x /usr/local/bin/tofu

# Install Terraform with SHA256 verification
ENV TERRAFORM_VERSION=1.9.3
RUN ARCH=${TARGETARCH:-amd64} && \
    curl -fLo terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" && \
    curl -fLo terraform_SHA256SUMS "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" && \
    grep "terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" terraform_SHA256SUMS | sha256sum -c - && \
    unzip terraform.zip -d /usr/local/bin && \
    rm terraform.zip terraform_SHA256SUMS && \
    chmod +x /usr/local/bin/terraform

# Copy monorepo files for backend
COPY bun.lock ./
COPY package.json ./
COPY backend/package.json ./backend/
COPY backend/drizzle.config.ts ./backend/
COPY backend/drizzle ./backend/drizzle
COPY backend/index.ts ./backend/
COPY backend/src ./backend/src

# Install production dependencies for backend
WORKDIR /app/backend
RUN bun install --production

# Copy built frontend static assets
COPY --from=builder /app/frontend/dist /app/frontend/dist

# Create storage directory & unprivileged user
RUN mkdir -p /app/backend/storage && \
    useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app

VOLUME ["/app/backend/storage"]

USER appuser

# Expose server port
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/readyz" > /dev/null || exit 1

CMD ["bun", "run", "index.ts"]
