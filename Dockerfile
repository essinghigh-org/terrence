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
WORKDIR /app

# Install dependencies needed for OpenTofu
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install OpenTofu
ENV TOFU_VERSION=1.7.0
RUN curl -Lo tofu.zip "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.zip" && \
    unzip tofu.zip -d /usr/local/bin && \
    rm tofu.zip && \
    chmod +x /usr/local/bin/tofu

# Copy backend files
COPY bun.lock ./
COPY backend/package.json ./backend/
COPY backend/index.ts ./backend/
COPY backend/src ./backend/src

# Install only production dependencies for backend
WORKDIR /app/backend
RUN bun install --production

# Copy built frontend files
COPY --from=builder /app/frontend/dist /app/frontend/dist

# Expose backend port
EXPOSE 3000

# Start backend
WORKDIR /app/backend
CMD ["bun", "run", "index.ts"]
