# Friday Platform image: atlasd + link + agent-playground
#
# Build:
#   docker build -t friday-platform .
#
# Run:
#   docker run --env-file .env -p 18080:8080 -p 13100:3100 -p 15200:5200 -p 17681:7681 -p 19090:9090 friday-platform
#
# Ports:
#   18080  atlasd (daemon API) - mapped to container port 8080
#   13100  link (credential/auth service) - mapped to container port 3100
#   15200  agent-playground (web UI) - mapped to container port 5200
#   17681  pty-server (WebSocket PTY for CLI cheatsheet terminal) - mapped to container port 7681
#   19090  webhook-tunnel - mapped to container port 9090

# ============================================================================
# Stage 1: Build — compile binaries & install deps
# ============================================================================
FROM denoland/deno:debian-2.7.4 AS builder

WORKDIR /app

# Need Node.js/npm for building @atlas/ui (svelte-package)
# python3 + build-essential for compiling node-pty native addon (pty-server)
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for layer caching — deno install only
# reruns when manifests change, not when source code changes.
COPY deno.json deno.lock package.json ./
COPY apps/atlasd/deno.json apps/atlasd/package.json* ./apps/atlasd/
COPY apps/atlas-cli/deno.json apps/atlas-cli/package.json* ./apps/atlas-cli/
COPY apps/link/deno.json apps/link/package.json* ./apps/link/
COPY apps/webhook-tunnel/deno.json apps/webhook-tunnel/package.json ./apps/webhook-tunnel/
COPY tools/agent-playground/deno.json tools/agent-playground/package.json ./tools/agent-playground/
COPY tools/evals/deno.json tools/evals/package.json ./tools/evals/
COPY tools/pty-server/deno.json tools/pty-server/package.json ./tools/pty-server/
COPY packages/ ./packages/

# Install dependencies (cached unless manifests above change)
RUN deno install

# Copy full source (changes frequently but doesn't bust the install cache)
COPY . .

# Build @atlas/ui — the playground imports from dist/ which needs svelte-package
WORKDIR /app/packages/ui
RUN npx svelte-kit sync && npx svelte-package -o dist

# Generate .svelte-kit/tsconfig.json for the playground so vite doesn't warn
WORKDIR /app/tools/agent-playground
RUN npx svelte-kit sync

# Ensure pty-server spawn-helper is executable (node-pty prebuild).
# Deno's install doesn't set the execute bit on prebuilt binaries.
# Check both root node_modules and Deno's .deno/ layout.
RUN chmod +x /app/node_modules/node-pty/prebuilds/linux-*/spawn-helper 2>/dev/null || true && \
    chmod +x /app/node_modules/.deno/node-pty@*/node_modules/node-pty/prebuilds/linux-*/spawn-helper 2>/dev/null || true

WORKDIR /app

# ── Compile standalone binaries ──────────────────────────────────────────────

# Atlas daemon CLI — mirrors main Dockerfile compile flags.
# Temporarily hide packages/ui (contains .svelte files deno compile can't handle)
# then restore it for the runtime stage COPY.
RUN mv packages/ui /tmp/_ui && mv node_modules/@atlas/ui /tmp/_atlas_ui 2>/dev/null; \
    OTEL_DENO=true deno compile -q --no-check --allow-all \
    --include=apps/atlas-cli \
    --include=packages \
    --include=node_modules/@opentelemetry \
    --config=deno.json \
    --unstable-broadcast-channel \
    --unstable-worker-options --unstable-kv --unstable-raw-imports \
    --output /app/bin/atlas \
    apps/atlas-cli/src/otel-bootstrap.ts && \
    mv /tmp/_ui packages/ui && mv /tmp/_atlas_ui node_modules/@atlas/ui 2>/dev/null; true

# Link service
RUN deno compile -q --no-check --allow-all \
    --unstable-kv \
    --output /app/bin/link \
    apps/link/src/index.ts

# Webhook tunnel
RUN deno compile -q --no-check --allow-all \
    --output /app/bin/webhook-tunnel \
    apps/webhook-tunnel/src/index.ts

# ============================================================================
# Stage 2: Runtime — all services in one container
# ============================================================================
FROM denoland/deno:debian-2.7.4

# Create non-root user FIRST so COPY --chown works without duplicating layers
RUN groupadd -g 10001 atlas && \
    useradd -u 10001 -g atlas -d /home/atlas -s /bin/sh -m atlas

# Install Node.js, npm, git, GitHub CLI, and bash for the entrypoint
# git is needed by the bb agent (Bitbucket clone) and gh agent
# Claude Code CLI for the claude-code agent
COPY docker/package.json /tmp/docker-deps/package.json
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      nodejs npm bash curl jq git sqlite3 libsqlite3-0 ca-certificates gnupg \
      bubblewrap socat && \
    # GitHub CLI — add official apt repository
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/* && \
    # Claude Code CLI
    cd /tmp/docker-deps && npm install && \
    cp -r node_modules/@anthropic-ai/claude-code /usr/local/lib/claude-code && \
    ln -s /usr/local/lib/claude-code/cli.js /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude && \
    rm -rf /tmp/docker-deps

# Agent build toolchain — componentize-py + jco for server-side Python→WASM builds
# Python 3 is needed by componentize-py; jco is an npm global
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --no-cache-dir --break-system-packages componentize-py==0.22.0 uv && \
    npm install -g @bytecodealliance/jco@1.16.1

# Copy friday-agent-sdk (Python package + WIT definitions) to well-known container path
COPY --from=builder /app/packages/sdk-python/friday_agent_sdk /opt/friday-agent-sdk/friday_agent_sdk
COPY --from=builder /app/packages/sdk-python/wit /opt/friday-agent-sdk/wit

# cloudflared for webhook tunnel (multi-arch: amd64 + arm64)
COPY --from=cloudflare/cloudflared:2026.3.0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# Symlink system libsqlite3 to a stable path so @db/sqlite uses it (Debian
# puts it under /usr/lib/<arch>/, which varies by platform)
RUN ln -sf "$(find /usr/lib -name 'libsqlite3.so.0' -print -quit)" /usr/lib/libsqlite3.so.0

# Create data and config directories owned by atlas
RUN mkdir -p /data/atlas /data/link /tmp/.npm /app/config && \
    chown -R 10001:10001 /data /tmp/.npm /home/atlas /app/config

# ── Install compiled binaries (no layer duplication) ─────────────────────────
COPY --from=builder /app/bin/atlas /usr/local/bin/atlas
COPY --from=builder /app/bin/link /usr/local/bin/link
COPY --from=builder /app/bin/webhook-tunnel /usr/local/bin/webhook-tunnel

WORKDIR /app

# ── Copy runtime source for services that can't be compiled ──────────────────
# agent-playground: Vite dev server needs source + node_modules
# pty-server: node-pty native addon can't be bundled by deno compile

# Workspace config (Deno needs these to resolve imports for playground/pty)
COPY --chown=atlas:atlas --from=builder /app/deno.json /app/deno.lock /app/package.json /app/tsconfig.json /app/reset.d.ts /app/
COPY --chown=atlas:atlas --from=builder /app/types /app/types

# Rewrite deno.json AND package.json workspace to only list members we
# actually copy. The source uses "./apps/*" glob which fails when most
# apps are absent. Deno reads both files for workspace resolution.
RUN node -e " \
  const ws = [ \
    './packages/*', \
    './tools/agent-playground', './tools/pty-server' \
  ]; \
  for (const f of ['/app/deno.json', '/app/package.json']) { \
    const c = JSON.parse(require('fs').readFileSync(f, 'utf8')); \
    const key = c.workspace ? 'workspace' : 'workspaces'; \
    c[key] = ws; \
    require('fs').writeFileSync(f, JSON.stringify(c, null, 2) + '\n'); \
  }" && chown atlas:atlas /app/deno.json /app/package.json /app/deno.lock

# Runtime tools (playground needs source + svelte-kit, pty needs node-pty)
COPY --chown=atlas:atlas --from=builder /app/tools/agent-playground /app/tools/agent-playground
COPY --chown=atlas:atlas --from=builder /app/tools/pty-server /app/tools/pty-server

# Shared packages (playground imports @atlas/ui etc.)
COPY --chown=atlas:atlas --from=builder /app/packages /app/packages

# Agent definitions
COPY --chown=atlas:atlas --from=builder /app/.agents /app/.agents

# Default webhook mappings (can be overridden via volume mount)
COPY --chown=atlas:atlas apps/webhook-tunnel/webhook-mappings.yml /app/config/webhook-mappings.yml

# node_modules — only needed for playground (vite, svelte) and pty-server (node-pty)
COPY --chown=atlas:atlas --from=builder /app/node_modules /app/node_modules

# Deno cache — only what playground and pty-server need at runtime.
# The compiled binaries (atlas, link, webhook-tunnel) are self-contained.
COPY --chown=atlas:atlas --from=builder /deno-dir /deno-dir
# Fix /deno-dir top-level dir ownership (base image creates it as deno:deno,
# COPY --chown only sets ownership on copied contents, not the existing dir)
RUN chown atlas:atlas /deno-dir

# Copy entrypoint
COPY --chown=atlas:atlas docker/run-platform.sh /app/run-platform.sh
RUN chmod +x /app/run-platform.sh

USER atlas

# OCI image metadata
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Friday Platform" \
      org.opencontainers.image.description="Friday developer platform — agentic orchestration runtime" \
      org.opencontainers.image.source="https://platform.hellofriday.ai/docs" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.vendor="Friday"

# Environment defaults
ENV DENO_NO_UPDATE_CHECK=1 \
    DENO_DIR=/deno-dir \
    npm_config_cache=/tmp/.npm \
    ATLAS_HOME=/data/atlas \
    FRIDAY_LOG_LEVEL=info \
    ATLAS_CONFIG_PATH=/app/config \
    ATLAS_NPX_PATH=/usr/bin/npx \
    ATLAS_CLAUDE_PATH=/usr/local/bin/claude \
    FRIDAY_SQLITE3_PATH=/usr/bin/sqlite3 \
    DENO_SQLITE_PATH=/usr/lib/libsqlite3.so.0 \
    WEBHOOK_MAPPINGS_PATH=/app/config/webhook-mappings.yml \
    AGENT_SOURCE_DIR=/home/atlas/agent-src \
    LINK_DEV_MODE=true \
    LINK_PORT=3100 \
    DEV_MODE=true \
    SHELL=/bin/bash

EXPOSE 8080 3100 5200 7681 9090

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:8080/health > /dev/null && \
        curl -sf http://localhost:3100/health > /dev/null && \
        curl -sf http://localhost:7681/health > /dev/null && \
        curl -sf http://localhost:9090/health > /dev/null || exit 1

ENTRYPOINT ["/app/run-platform.sh"]
