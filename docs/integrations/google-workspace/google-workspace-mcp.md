# Google Workspace MCP Integration

Give Friday access to Calendar, Gmail, Drive, Docs, and Sheets.

## Prerequisites

- Docker
- Google Cloud project

## Setup

### 1. Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth client ID**
5. Select **Web application** as the application type
6. Add authorized redirect URI: `http://localhost:3100/v1/oauth/callback`
7. Save your **Client ID** and **Client Secret**

Enable the APIs you need:

- [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
- [Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)

### 2. Store Credentials

```bash
mkdir -p ~/.atlas
echo "YOUR_CLIENT_ID.apps.googleusercontent.com" > ~/.atlas/google_client_id
echo "GOCSPX-your-client-secret" > ~/.atlas/google_client_secret
chmod 600 ~/.atlas/google_client_*
```

### 3. Start the MCP Container

```bash
docker build -t google-workspace-mcp -f apps/google-workspace-mcp/Dockerfile .
docker run -d -p 8000:8000 --name google-workspace-mcp google-workspace-mcp
```

Verify:

```bash
curl http://localhost:8000/health
```

### 4. Start Link Service

Create `apps/link/.env`:

```bash
LINK_DEV_MODE=true
GOOGLE_CLIENT_ID_FILE=$HOME/.atlas/google_client_id
GOOGLE_CLIENT_SECRET_FILE=$HOME/.atlas/google_client_secret
```

```bash
cd apps/link && deno task dev
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
