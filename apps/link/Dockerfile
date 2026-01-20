# Atlas Link service Dockerfile

FROM denoland/deno:alpine-2.6.5 AS builder

WORKDIR /app

COPY packages/core/ ./packages/core/
COPY packages/utils/ ./packages/utils/
COPY packages/logger/ ./packages/logger/
COPY packages/sentry/ ./packages/sentry/
COPY apps/link/deno.json ./apps/link/
COPY apps/link/src/ ./apps/link/src/

WORKDIR /app/apps/link
RUN deno compile --allow-all --no-check --output=link --unstable-kv --config=deno.json src/index.ts

FROM debian:bookworm-20260112-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/apps/link/link /app/link

USER 65534:65534
CMD ["/app/link"]
