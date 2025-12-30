FROM python:3.11.14-alpine3.23

ARG WORKSPACE_MCP_VERSION

WORKDIR /app

# Install uv for faster dependency management
RUN pip install --no-cache-dir uv

# Copy requirements
COPY apps/google-workspace-mcp/requirements.txt .

# Install workspace-mcp
RUN if [ -n "$WORKSPACE_MCP_VERSION" ]; then \
      uv pip install --system --no-cache "workspace-mcp==${WORKSPACE_MCP_VERSION}"; \
    else \
      uv pip install --system --no-cache -r requirements.txt; \
    fi

# Apply TLS support patch (version-agnostic, pattern-based)
COPY apps/google-workspace-mcp/apply-tls-patch.py /tmp/
RUN python /tmp/apply-tls-patch.py && rm /tmp/apply-tls-patch.py

# Copy entrypoint
COPY apps/google-workspace-mcp/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create non-root user
RUN addgroup -g 65534 -S app && \
    adduser -u 65534 -S -G app -H -s /sbin/nologin app

# Environment for read-only filesystem compatibility
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

USER 65534:65534

# External OAuth 2.1 mode - fully stateless, no secrets needed
ENV MCP_ENABLE_OAUTH21="true" \
    EXTERNAL_OAUTH21_PROVIDER="true" \
    WORKSPACE_MCP_STATELESS_MODE="true" \
    GOOGLE_OAUTH_CLIENT_ID="external" \
    GOOGLE_OAUTH_CLIENT_SECRET="external" \
    TOOL_TIER="" \
    TOOLS="" \
    PORT=8000

# TLS: Mount certificates and set these env vars to enable HTTPS
# SSL_KEYFILE=/certs/tls.key
# SSL_CERTFILE=/certs/tls.crt

ENTRYPOINT ["/entrypoint.sh"]
