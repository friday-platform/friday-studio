FROM ghcr.io/berriai/litellm-non_root:litellm_stable_release_branch-v1.81.3-stable.sonnet-4-6

USER root

# The base deployment mounts an emptyDir at /app/.cache, which hides the
# Prisma query engine binary cached there by the upstream image. Copy it
# to /usr/bin/ so it survives the volume mount.
RUN cp /app/.cache/prisma-python/binaries/node_modules/prisma/query-engine-debian-openssl-3.0.x \
       /usr/bin/prisma-query-engine && \
    chmod +x /usr/bin/prisma-query-engine

# Wolfi uses glibc but prisma-client-py misdetects the platform as
# debian-openssl-3.6.x. Override to skip broken auto-detection.
ENV PRISMA_QUERY_ENGINE_BINARY="/usr/bin/prisma-query-engine"

USER nobody
WORKDIR /app
