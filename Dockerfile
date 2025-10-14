# Multi-stage Dockerfile for Atlas AI Agent Platform
# Optimized for production deployment in Kubernetes

# Stage 1: Build stage
FROM denoland/deno:alpine-2.5.4 AS builder

# Set working directory
WORKDIR /app

# Create atlas user for security (Deno image is based on Alpine)
# Use a different GID/UID to avoid conflicts with existing users
RUN addgroup -g 1001 -S atlas && adduser -u 1001 -S -G atlas -h /home/atlas -s /bin/sh atlas

# Copy package files first for better caching
COPY deno.json deno.lock package.json ./
COPY apps/atlasd/deno.json ./apps/atlasd/
COPY packages/ ./packages/
COPY tools/memory_manager/ ./tools/memory_manager/

# Copy source code
COPY . .

# Install dependencies (populates node_modules for bare import resolution)
RUN deno install

# Compile the Atlas CLI to a single binary for optimal performance
RUN deno compile \
    --allow-all \
    --no-check \
    --output=atlas \
    --config=deno.json \
    --unstable-broadcast-channel \
    --unstable-worker-options \
    --unstable-kv \
    --unstable-raw-imports \
    src/cli.tsx

# Stage 2: Runtime stage - use deno alpine image for compatibility
FROM denoland/deno:alpine-2.5.4 AS runtime

# Create atlas user and group (if not already exists)
RUN addgroup -g 1001 -S atlas 2>/dev/null || true && \
    adduser -u 1001 -S -G atlas -h /home/atlas -s /bin/sh atlas 2>/dev/null || true

# Create necessary directories with proper permissions
RUN mkdir -p /home/atlas/.atlas/logs \
    /home/atlas/.atlas/workspaces \
    /home/atlas/.atlas/data \
    && chown -R atlas:atlas /home/atlas

# Copy the compiled Atlas binary from builder stage
COPY --from=builder --chown=atlas:atlas /app/atlas /usr/local/bin/atlas

# Make the binary executable
RUN chmod +x /usr/local/bin/atlas

# Switch to atlas user
USER atlas
WORKDIR /home/atlas

# Set environment variables for optimal operation
ENV DENO_NO_UPDATE_CHECK=1 \
    ATLAS_HOME=/home/atlas/.atlas \
    ATLAS_LOG_LEVEL=info \
    ATLAS_DAEMON_HOST=0.0.0.0 \
    ATLAS_DAEMON_PORT=8080

# Expose the daemon port
EXPOSE 8080

# Default command starts the daemon
CMD ["atlas", "daemon", "start", "--hostname", "0.0.0.0", "--port", "8080"]