# Atlas Ledger service Dockerfile

FROM denoland/deno:alpine-2.7.6 AS builder

WORKDIR /app

COPY packages/activity/ ./packages/activity/
COPY packages/utils/ ./packages/utils/
COPY packages/logger/ ./packages/logger/
COPY packages/sentry/ ./packages/sentry/
COPY apps/ledger/deno.json ./apps/ledger/
COPY apps/ledger/src/ ./apps/ledger/src/

WORKDIR /app/apps/ledger
RUN deno compile --allow-all --no-check --output=ledger --config=deno.json src/index.ts

FROM debian:bookworm-20260316-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /usr/lib/*/libsqlite3.so.0 /usr/lib/libsqlite3.so.0

# @db/sqlite uses DENO_SQLITE_PATH to dlopen directly, skipping the
# @denosaurs/plug download that fails without a writable $HOME.
ENV DENO_SQLITE_PATH=/usr/lib/libsqlite3.so.0

WORKDIR /app
COPY --from=builder /app/apps/ledger/ledger /app/ledger

USER 65534:65534
CMD ["/app/ledger"]
