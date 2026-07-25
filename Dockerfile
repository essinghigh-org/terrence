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
