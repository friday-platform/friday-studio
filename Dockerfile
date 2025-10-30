# Multi-stage Dockerfile for Atlas AI Agent Platform
# Optimized for production deployment in Kubernetes
#
# Build targets:
#   - daemon (default): Atlas daemon binary
#   - web-client: Static web UI served via HTTP
#
# Build commands:
#   docker build --target daemon -t atlas-daemon .
#   docker build --target web-client -t atlas-web-client .

# ============================================================================
# DAEMON BUILD STAGES
# ============================================================================

# Stage 1: Build daemon binary
FROM denoland/deno:alpine-2.5.6 AS daemon-builder

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

# Stage 2: Daemon runtime
FROM denoland/deno:alpine-2.5.6 AS daemon

# Install Node.js and npm for npx support (required for MCP servers)
RUN apk add --no-cache nodejs npm

# Create atlas user and group (if not already exists)
RUN addgroup -g 1001 -S atlas 2>/dev/null || true && \
    adduser -u 1001 -S -G atlas -h /home/atlas -s /bin/sh atlas 2>/dev/null || true

# Create necessary directories with proper permissions
RUN mkdir -p /home/atlas/.atlas/logs \
    /home/atlas/.atlas/workspaces \
    /home/atlas/.atlas/data \
    && chown -R atlas:atlas /home/atlas

# Copy the compiled Atlas binary from daemon-builder stage
COPY --from=daemon-builder --chown=atlas:atlas /app/atlas /usr/local/bin/atlas

# Make the binary executable
RUN chmod +x /usr/local/bin/atlas

# Switch to atlas user
USER atlas
WORKDIR /home/atlas

# Set environment variables for optimal operation
# Prepend system lib path to LD_LIBRARY_PATH so Node.js uses system libgcc
ENV DENO_NO_UPDATE_CHECK=1 \
    ATLAS_HOME=/home/atlas/.atlas \
    ATLAS_LOG_LEVEL=info \
    ATLAS_DAEMON_HOST=0.0.0.0 \
    ATLAS_DAEMON_PORT=8080 \
    ATLAS_NPX_PATH=/usr/bin/npx \
    LD_LIBRARY_PATH=/usr/lib:/usr/local/lib

# Expose the daemon port
EXPOSE 8080

# Default command starts the daemon
CMD ["atlas", "daemon", "start", "--hostname", "0.0.0.0", "--port", "8080"]

# ============================================================================
# WEB CLIENT BUILD STAGES
# ============================================================================

# Stage 3: Build web client static assets
FROM denoland/deno:alpine-2.5.6 AS web-client-builder

WORKDIR /app

# Copy all files (simpler approach for first working version)
COPY . .

# Install dependencies (populates node_modules for vite/svelte)
RUN deno install

# Configure SvelteKit base path
# TODO: Move this to build pipeline configuration
ARG SVELTEKIT_BASE_PATH=/app
ENV SVELTEKIT_BASE_PATH=${SVELTEKIT_BASE_PATH}

# Build static assets using Deno task
WORKDIR /app/apps/web-client
RUN deno task build

# Compile server.ts to a self-contained binary
# This approach avoids JSR transitive dependency caching issues entirely
# by embedding all dependencies directly in the executable
WORKDIR /app
RUN deno compile \
    --allow-net \
    --allow-read \
    --allow-env \
    --output=/app/server \
    apps/web-client/server.ts

# Stage 4: Web client runtime
FROM denoland/deno:alpine-2.5.6 AS web-client

# Create atlas user and group
RUN addgroup -g 1001 -S atlas 2>/dev/null || true && \
    adduser -u 1001 -S -G atlas -h /home/atlas -s /bin/sh atlas 2>/dev/null || true

# Create web and cache directories
RUN mkdir -p /home/atlas/web /home/atlas/.cache && chown -R atlas:atlas /home/atlas

# Copy built static assets from web-client-builder
COPY --from=web-client-builder --chown=atlas:atlas /app/apps/web-client/build /home/atlas/web

# Copy compiled server binary
# All dependencies are embedded in the binary, no runtime resolution needed
COPY --from=web-client-builder --chown=atlas:atlas /app/server /home/atlas/server

# Switch to atlas user
USER atlas
WORKDIR /home/atlas

# Set environment variables
ENV DENO_NO_UPDATE_CHECK=1 \
    WEB_CLIENT_HOST=0.0.0.0 \
    WEB_CLIENT_PORT=3000 \
    ATLAS_LOG_FORMAT=json

# Expose web client port
EXPOSE 3000

# Start compiled server binary
CMD ["/home/atlas/server"]