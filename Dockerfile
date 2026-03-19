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
FROM denoland/deno:alpine-2.7.4 AS daemon-builder

# Set working directory
WORKDIR /app

# Create atlas user for security (Deno image is based on Alpine)
# UID 65534 / GID 266 matches Kubernetes securityContext for consistency
RUN addgroup -g 266 -S atlas && \
    deluser nobody 2>/dev/null || true && \
    adduser -u 65534 -S -G atlas -h /home/atlas -s /bin/sh atlas

# Copy package files first for better caching
COPY deno.json deno.lock package.json ./
COPY apps/atlasd/deno.json ./apps/atlasd/
COPY apps/atlas-cli/deno.json ./apps/atlas-cli/
COPY packages/ ./packages/

# Copy source code
COPY . .

# Install dependencies (populates node_modules for bare import resolution)
RUN deno install

# Remove packages that contain non-JS/TS modules (e.g. .svelte files)
# which deno compile cannot handle. The web-client stage has its own COPY.
RUN rm -rf packages/ui node_modules/@atlas/ui

# Compile the Atlas CLI to a single binary for optimal performance
# OTEL_DENO=true must be set at compile time - the config is baked into the binary
RUN OTEL_DENO=true deno compile \
    --include=apps/atlas-cli \
    --include=packages \
    --include=node_modules/@opentelemetry \
    --allow-all \
    --no-check \
    --output=atlas \
    --config=deno.json \
    --unstable-broadcast-channel \
    --unstable-worker-options \
    --unstable-kv \
    --unstable-raw-imports \
    apps/atlas-cli/src/cli.ts

# Stage 2: Daemon runtime
FROM denoland/deno:alpine-2.7.4 AS daemon

# Install Node.js, npm, GitHub CLI, and Claude Code CLI
# Version is managed in docker/package.json (updated by Dependabot)
# Note: LD_LIBRARY_PATH is set to use system libgcc instead of Deno's bundled one
# libstdc++ is required for DuckDB (C++ runtime)
COPY docker/package.json /tmp/docker-deps/package.json
RUN apk add --no-cache nodejs npm bash github-cli sqlite-libs sqlite libstdc++ && \
    cd /tmp/docker-deps && LD_LIBRARY_PATH=/usr/lib:/usr/local/lib npm install && \
    cp -r node_modules/@anthropic-ai/claude-code /usr/local/lib/claude-code && \
    ln -s /usr/local/lib/claude-code/cli.js /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude && \
    rm -rf /tmp/docker-deps

# Copy DuckDB binary for fast CSV→SQLite conversion (2.5x faster than JS)
# Pre-built for Alpine/musl at https://github.com/tempestteam/duckdb
COPY --from=ghcr.io/tempestteam/duckdb:1.4.4 /usr/local/bin/duckdb /usr/local/bin/duckdb

# Create atlas user and group matching Kubernetes securityContext (65534:266)
RUN addgroup -g 266 -S atlas && \
    deluser nobody 2>/dev/null || true && \
    adduser -u 65534 -S -G atlas -h /home/atlas -s /bin/sh atlas

# Create necessary directories with proper permissions
RUN mkdir -p /home/atlas/.atlas/logs \
    /home/atlas/.atlas/workspaces \
    /home/atlas/.atlas/data \
    && chown -R atlas:atlas /home/atlas

# Copy the compiled Atlas binary from daemon-builder stage
# Owned by root:root with minimal permissions (005 = -------r-x)
# Only "others" need read+execute; owner/group perms don't matter since root bypasses them
# Note: Deno compiled binaries require read access to extract embedded JS
COPY --from=daemon-builder /app/atlas /usr/local/bin/atlas
RUN chmod 005 /usr/local/bin/atlas

# Switch to atlas user
USER atlas
WORKDIR /home/atlas

# Set environment variables for optimal operation
ENV DENO_NO_UPDATE_CHECK=1 \
    DENO_DIR=/tmp/.deno \
    npm_config_cache=/tmp/.npm \
    ATLAS_HOME=/home/atlas/.atlas \
    ATLAS_LOG_LEVEL=info \
    ATLAS_DAEMON_HOST=0.0.0.0 \
    ATLAS_DAEMON_PORT=8080 \
    ATLAS_NPX_PATH=/usr/bin/npx \
    ATLAS_CLAUDE_PATH=/usr/local/bin/claude \
    ATLAS_DUCKDB_PATH=/usr/local/bin/duckdb \
    ATLAS_SQLITE3_PATH=/usr/bin/sqlite3 \
    LD_LIBRARY_PATH=/usr/lib:/usr/local/lib \
    DENO_SQLITE_PATH=/usr/lib/libsqlite3.so.0

# Expose the daemon port
EXPOSE 8080

# Default command starts the daemon
CMD ["atlas", "daemon", "start", "--hostname", "0.0.0.0", "--port", "8080"]

# ============================================================================
# WEB CLIENT BUILD STAGES
# ============================================================================

# Stage 3: Build web client static assets
FROM denoland/deno:alpine-2.7.4 AS web-client-builder

# Accept build args for version info
ARG GITHUB_SHA=unknown

WORKDIR /app

# Copy all files (simpler approach for first working version)
COPY . .

# Install dependencies (populates node_modules for vite/svelte)
RUN deno install

# Build static assets using Deno task
# GITHUB_SHA is truncated to 8 chars by generate-build-info.ts
WORKDIR /app/apps/web-client
RUN GITHUB_SHA="${GITHUB_SHA}" deno task build

# Stage 4: Web client runtime
FROM nginxinc/nginx-unprivileged:1.29.3-alpine3.22 AS web-client

# Copy built static assets from web-client-builder
COPY --from=web-client-builder /app/apps/web-client/build /usr/share/nginx/html

# Copy nginx configuration
COPY --from=web-client-builder /app/apps/web-client/nginx-http.conf /etc/nginx/conf.d/00-http.conf
COPY --from=web-client-builder /app/apps/web-client/nginx.conf /etc/nginx/conf.d/default.conf

# Expose web client port
EXPOSE 3000

# Run as non-root user (nginx:nginx, uid=101)
CMD ["nginx", "-g", "daemon off;"]
