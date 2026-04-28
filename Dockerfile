# Friday Platform image: atlasd + link + agent-playground + webhook-tunnel + pty-server
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
# Stage 1: Deno builder — compile atlas/link binaries & prepare playground
# ============================================================================
FROM denoland/deno:debian-2.7.4 AS deno-builder

WORKDIR /app

# Need Node.js/npm for building @atlas/ui (svelte-package) and the playground.
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for layer caching — deno install only
# reruns when manifests change, not when source code changes.
COPY deno.json deno.lock package.json ./
COPY apps/atlasd/deno.json apps/atlasd/package.json* ./apps/atlasd/
COPY apps/atlas-cli/deno.json apps/atlas-cli/package.json* ./apps/atlas-cli/
COPY apps/link/deno.json apps/link/package.json* ./apps/link/
COPY apps/ledger/deno.json apps/ledger/package.json* ./apps/ledger/
COPY tools/agent-playground/deno.json tools/agent-playground/package.json ./tools/agent-playground/
COPY tools/evals/deno.json tools/evals/package.json ./tools/evals/
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

WORKDIR /app

# ── Compile standalone Deno binaries ─────────────────────────────────────────

# Atlas daemon CLI.
# Temporarily hide packages/ui (contains .svelte files deno compile can't handle)
# then restore it for the runtime stage COPY. RUST_MIN_STACK bumps the tokio
# worker thread stack — recursive Zod schemas overflow the default 2MB.
RUN mv packages/ui /tmp/_ui && mv node_modules/@atlas/ui /tmp/_atlas_ui 2>/dev/null || true; \
    RUST_MIN_STACK=16777216 OTEL_DENO=true deno compile -q --no-check --allow-all \
    --include=apps/atlas-cli \
    --include=packages \
    --include=node_modules/@opentelemetry \
    --config=deno.json \
    --unstable-broadcast-channel \
    --unstable-worker-options --unstable-kv --unstable-raw-imports \
    --output /app/bin/atlas \
    apps/atlas-cli/src/otel-bootstrap.ts; \
    rc=$?; \
    mv /tmp/_ui packages/ui && mv /tmp/_atlas_ui node_modules/@atlas/ui 2>/dev/null || true; \
    exit $rc

# Link service.
# RUST_MIN_STACK bumps the tokio worker thread stack — link's deeply-nested
# Zod schemas blow the default 2MB stack during deno compile. 16MB is plenty.
RUN RUST_MIN_STACK=16777216 deno compile -q --no-check --allow-all \
    --unstable-kv \
    --output /app/bin/link \
    apps/link/src/index.ts

# Ledger service (resources + activity backend).
RUN RUST_MIN_STACK=16777216 deno compile -q --no-check --allow-all \
    --output /app/bin/ledger \
    apps/ledger/src/index.ts

# ============================================================================
# Stage 2: Go builder — compile webhook-tunnel and pty-server binaries
# ============================================================================
FROM golang:1.26-bookworm AS go-builder

WORKDIR /src

# Single root Go module — copy manifests first for layer caching.
COPY go.mod go.sum ./

# Copy every directory referenced by the root Go module.
COPY pkg ./pkg
COPY tools ./tools
COPY apps ./apps

# Static, fully-portable binaries (CGO disabled).
RUN CGO_ENABLED=0 go build -o /out/webhook-tunnel ./tools/webhook-tunnel && \
    CGO_ENABLED=0 go build -o /out/pty-server     ./tools/pty-server

# ============================================================================
# Stage 3: Runtime — all services in one container
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
    # Claude Code CLI — 2.x ships a Bun-compiled native binary at bin/claude.exe
    # (the .exe suffix is package convention, not platform-specific).
    cd /tmp/docker-deps && npm install && \
    cp -r node_modules/@anthropic-ai/claude-code /usr/local/lib/claude-code && \
    chmod +x /usr/local/lib/claude-code/bin/claude.exe && \
    ln -s /usr/local/lib/claude-code/bin/claude.exe /usr/local/bin/claude && \
    rm -rf /tmp/docker-deps

# Agent build toolchain — componentize-py + jco for server-side Python→WASM builds
# Python 3 is needed by componentize-py; jco is an npm global
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --no-cache-dir --break-system-packages componentize-py==0.22.0 uv && \
    npm install -g @bytecodealliance/jco@1.16.1

# NOTE: the Python `friday_agent_sdk` package + WIT definitions live in a
# separate repo (friday-platform/agent-sdk). The componentize-py and jco
# toolchain installed below can compile Python agents only when the SDK is
# mounted into /opt/friday-agent-sdk at runtime (e.g. via `-v
# /path/to/agent-sdk/packages/python:/opt/friday-agent-sdk:ro`).

# cloudflared for webhook tunnel (multi-arch: amd64 + arm64)
COPY --from=cloudflare/cloudflared:2026.3.0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# nats-server (multi-arch). Daemon spawns this for the internal messaging bus.
COPY --from=nats:2.12.8-alpine /usr/local/bin/nats-server /usr/local/bin/nats-server

# Symlink system libsqlite3 to a stable path so @db/sqlite uses it (Debian
# puts it under /usr/lib/<arch>/, which varies by platform)
RUN ln -sf "$(find /usr/lib -name 'libsqlite3.so.0' -print -quit)" /usr/lib/libsqlite3.so.0

# Create data and config directories owned by atlas
RUN mkdir -p /data/atlas /data/link /tmp/.npm /app/config && \
    chown -R 10001:10001 /data /tmp/.npm /home/atlas /app/config

# ── Install compiled binaries (no layer duplication) ─────────────────────────
COPY --from=deno-builder /app/bin/atlas         /usr/local/bin/atlas
COPY --from=deno-builder /app/bin/link          /usr/local/bin/link
COPY --from=deno-builder /app/bin/ledger        /usr/local/bin/ledger
COPY --from=go-builder   /out/webhook-tunnel    /usr/local/bin/webhook-tunnel
COPY --from=go-builder   /out/pty-server        /usr/local/bin/pty-server

WORKDIR /app

# ── Copy runtime source for services that can't be compiled ──────────────────
# agent-playground: Vite dev server needs source + node_modules

# Workspace config (Deno needs these to resolve imports for the playground)
COPY --chown=atlas:atlas --from=deno-builder /app/deno.json /app/deno.lock /app/package.json /app/tsconfig.json /app/reset.d.ts /app/
COPY --chown=atlas:atlas --from=deno-builder /app/types /app/types

# Rewrite deno.json AND package.json workspace to only list members we
# actually copy. The source uses "./apps/*" glob which fails when most
# apps are absent. Deno reads both files for workspace resolution.
RUN node -e " \
  const ws = [ \
    './packages/*', \
    './tools/agent-playground' \
  ]; \
  for (const f of ['/app/deno.json', '/app/package.json']) { \
    const c = JSON.parse(require('fs').readFileSync(f, 'utf8')); \
    const key = c.workspace ? 'workspace' : 'workspaces'; \
    c[key] = ws; \
    require('fs').writeFileSync(f, JSON.stringify(c, null, 2) + '\n'); \
  }" && chown atlas:atlas /app/deno.json /app/package.json /app/deno.lock

# Runtime tools (playground needs source + svelte-kit)
COPY --chown=atlas:atlas --from=deno-builder /app/tools/agent-playground /app/tools/agent-playground

# Shared packages (playground imports @atlas/ui etc.)
COPY --chown=atlas:atlas --from=deno-builder /app/packages /app/packages

# Agent definitions
COPY --chown=atlas:atlas --from=deno-builder /app/.agents /app/.agents

# node_modules — only needed for the playground (vite, svelte)
COPY --chown=atlas:atlas --from=deno-builder /app/node_modules /app/node_modules

# Deno cache — only what the playground needs at runtime.
# The compiled binaries (atlas, link, webhook-tunnel, pty-server) are self-contained.
COPY --chown=atlas:atlas --from=deno-builder /deno-dir /deno-dir
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
    FRIDAY_HOME=/data/atlas \
    FRIDAY_LOG_LEVEL=info \
    FRIDAY_CONFIG_PATH=/app/config \
    FRIDAY_NPX_PATH=/usr/bin/npx \
    FRIDAY_CLAUDE_PATH=/usr/local/bin/claude \
    FRIDAY_SQLITE3_PATH=/usr/bin/sqlite3 \
    DENO_SQLITE_PATH=/usr/lib/libsqlite3.so.0 \
    AGENT_SOURCE_DIR=/home/atlas/agent-src \
    LINK_DEV_MODE=true \
    LINK_PORT=3100 \
    DEV_MODE=true \
    SHELL=/bin/bash

EXPOSE 8080 3100 3200 5200 7681 9090

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:8080/health > /dev/null && \
        curl -sf http://localhost:3100/health > /dev/null && \
        curl -sf http://localhost:3200/health > /dev/null && \
        curl -sf http://localhost:7681/health > /dev/null && \
        curl -sf http://localhost:9090/health > /dev/null || exit 1

ENTRYPOINT ["/app/run-platform.sh"]
