# Multi-stage Dockerfile for Atlas Link service
# Credential management service using Deno + Hono
#
# This Dockerfile is optimized to produce a minimal binary by:
# 1. Only copying packages that link actually needs
# 2. Using a build-specific deno.json without unnecessary workspace members
# 3. Avoiding the bloated monorepo node_modules

# Stage 1: Build binary
FROM denoland/deno:alpine-2.6.1 AS builder

WORKDIR /app

# Copy root deno.json (source of truth for imports/versions)
COPY deno.json ./deno.json.full

# Copy only the packages that link actually needs:
# - @atlas/utils (paths, stringifyError)
# - @atlas/logger (logging)
# - @atlas/sentry (error tracking, used by logger)
COPY packages/utils/ ./packages/utils/
COPY packages/logger/ ./packages/logger/
COPY packages/sentry/ ./packages/sentry/

# Copy link app
COPY apps/link/ ./apps/link/

# Filter deno.json to only include link's workspace members
# This keeps imports/versions from root (Dependabot-maintained) but avoids pulling in unrelated packages
RUN apk add --no-cache jq && \
    jq '.workspace = ["./apps/link", "./packages/utils", "./packages/logger", "./packages/sentry"]' \
    deno.json.full > deno.json && \
    rm deno.json.full

# Install dependencies (only for the minimal workspace)
RUN deno install

# Compile Link service to a single binary
WORKDIR /app/apps/link
RUN deno compile \
    --allow-all \
    --no-check \
    --output=link \
    --config=../../deno.json \
    --unstable-kv \
    src/index.ts

# Stage 2: Runtime
FROM debian:bookworm-20251208-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary from builder
COPY --from=builder --chown=65534:65534 /app/apps/link/link /app/link

# Switch to nobody user
USER 65534:65534

# Run the compiled binary
CMD ["/app/link"]
