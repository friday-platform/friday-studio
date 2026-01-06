# Google Workspace MCP Integration

Give Friday access to Calendar, Gmail, Drive, Docs, and Sheets.

## Prerequisites

- Docker
- [1Password CLI](https://developer.1password.com/docs/cli/) with access to the Engineering vault

## Setup

### 1. Configure Secrets

```bash
./scripts/setup-secrets.sh
```

This pulls OAuth credentials from 1Password and creates `apps/link/.env`.

### 2. Start the MCP Container

```bash
docker build -t google-workspace-mcp -f apps/google-workspace-mcp/Dockerfile .
docker run -d -p 8000:8000 --name google-workspace-mcp google-workspace-mcp
```

Verify:

```bash
curl http://localhost:8000/health
```

### 3. Start Link Service

```bash
deno task dev
```

## Usage

Ask Friday to use any Google service in conversation. Friday will prompt you to connect your Google account when needed.

Example: *"Check my calendar for tomorrow"* → Friday initiates OAuth if not connected.

## Troubleshooting

**Container not starting**:
```bash
docker logs google-workspace-mcp --tail 50
```

**Start order matters**: MCP container → Link → Friday
