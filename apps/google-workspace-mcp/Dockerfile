FROM python:3.14-alpine

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

# Patch TLS support (upstream doesn't support SSL natively)
COPY apps/google-workspace-mcp/apply-tls-patch.py /tmp/
RUN python /tmp/apply-tls-patch.py && rm /tmp/apply-tls-patch.py

COPY --chmod=755 apps/google-workspace-mcp/entrypoint.sh /entrypoint.sh

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

USER nobody:nobody

# External OAuth 2.1 mode - fully stateless, no secrets needed
ENV EXTERNAL_OAUTH21_PROVIDER="true" \
    GOOGLE_OAUTH_CLIENT_ID="external" \
    GOOGLE_OAUTH_CLIENT_SECRET="external" \
    MCP_ENABLE_OAUTH21="true" \
    PORT=8000 \
    TOOL_TIER="" \
    TOOLS="" \
    WORKSPACE_MCP_STATELESS_MODE="true"

# TLS: Mount certificates and set these env vars to enable HTTPS
# SSL_KEYFILE=/certs/tls.key
# SSL_CERTFILE=/certs/tls.crt

ENTRYPOINT ["/entrypoint.sh"]
