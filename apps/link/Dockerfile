# Multi-stage Dockerfile for Atlas Link service
# Credential management service using Deno + Hono

# Stage 1: Build binary
FROM denoland/deno:alpine-2.5.6 AS builder

WORKDIR /app

# Create atlas user for security
RUN addgroup -g 1001 -S atlas && adduser -u 1001 -S -G atlas -h /home/atlas -s /bin/sh atlas

# Copy package files first for better caching
COPY deno.json deno.lock package.json ./
COPY apps/link/deno.json apps/link/package.json ./apps/link/
COPY packages/ ./packages/

# Copy source code
COPY . .

# Install dependencies (populates node_modules and deno cache)
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

# Create nobody user (65534) for consistency with other services
RUN groupadd -g 65534 nobody || true && \
    useradd -u 65534 -g 65534 -d /nonexistent -s /usr/sbin/nologin nobody || true

WORKDIR /app

# Copy the compiled binary from builder
COPY --from=builder --chown=65534:65534 /app/apps/link/link /app/link

# Make the binary executable
RUN chmod +x /app/link

# Switch to nobody user
USER 65534:65534

# Run the compiled binary
CMD ["/app/link"]
