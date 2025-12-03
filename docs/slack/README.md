# Slack Integration

Atlas integrates with Slack via **Socket Mode** (WebSocket) to trigger workspace signals from direct messages and channel mentions. **No public webhook URL required!**

## Architecture

```
Atlas Daemon starts
    ↓
Connect to Slack WebSocket (Socket Mode)
    ↓ wss://wss.slack.com/...
Receive message events
    ↓
SlackSocketClient (acknowledge events)
    ↓
SlackEventRouter (channel filtering)
    ↓ matched signals
WorkspaceSignalTrigger
```

**Similar to Discord Gateway** - persistent WebSocket connection, no webhooks needed.

## Features

**Message Events**
- Direct messages (DMs) trigger workspace signals
- Channel messages (when configured) trigger workspace signals
- Event-based routing with channel type filters
- Bot message filtering to prevent loops
- Thread support for contextual conversations
- No public URL required (WebSocket-based)

**Security**
- App-level token authentication (xapp-...)
- Envelope acknowledgment (3-second window)
- Automatic reconnection with exponential backoff
- No signature verification needed (authenticated WebSocket)

**Conversation Workspace Integration**
- Automatic routing to `atlas-conversation` workspace
- Persistent conversation IDs based on channel/thread
- Streaming responses via existing conversation agent
- Slack MCP server integration for sending messages

## Setup

### 1. Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name your app and select your workspace

### 2. Enable Socket Mode

1. Navigate to "Socket Mode" in app settings
2. **Enable Socket Mode** (toggle on)
3. Slack will prompt you to create an app-level token

### 3. Create App-Level Token

1. Click "Generate Token and Scopes"
2. Name it (e.g., "atlas-socket")
3. Add scope: `connections:write` (required for Socket Mode)
4. Click "Generate"
5. **Copy the token** - starts with `xapp-1-...`

### 4. Subscribe to Events

1. Navigate to "Event Subscriptions"
2. **Enable Events** (toggle on)
3. Under "Subscribe to bot events", add:
   - `message.channels` - For channel messages
   - `message.im` - For direct messages
   - `message.groups` - For private channels (optional)
   - `message.mpim` - For group DMs (optional)

**Note:** No Request URL needed! Socket Mode handles event delivery via WebSocket.

### 5. Install App

1. Navigate to "Install App" in settings
2. Click "Install to Workspace"
3. Authorize the app
4. **Copy the Bot User OAuth Token** - starts with `xoxb-...`

### 6. Configure Atlas

Set environment variables:

```bash
export ATLAS_SLACK_APP_TOKEN="xapp-1-..."    # App-level token (required)
export ATLAS_SLACK_BOT_TOKEN="xoxb-..."      # Bot token (required)
```

**Both tokens are required** for Socket Mode.

### 7. Restart Daemon

```bash
deno task daemon
```

You should see:
```
Initializing Slack Socket Mode integration...
Connecting to Slack Socket Mode...
Slack Socket Mode connected
Found conversation workspace for Slack integration
Slack Socket Mode integration initialized
```

## Configuration

### Workspace Signal Example

```yaml
# workspace.yml
signals:
  slack-notifications:
    provider: slack
    description: "Respond to Slack messages"
    config:
      events: [message]                    # Event types to listen for
      channels: [dm, channel]              # Channel type filters
      ignoreBotMessages: true              # Filter out bot messages

jobs:
  handle-slack:
    name: "handle-slack"
    description: "Process Slack messages"
    triggers:
      - signal: "slack-notifications"
    execution:
      strategy: "sequential"
      agents:
        - id: "my-agent"
```

### Signal Payload

When a Slack signal triggers, your agents receive this payload:

```typescript
{
  messageId: string;      // Message timestamp (unique ID)
  channelId: string;      // Channel where message was sent
  channelType: "im" | "channel" | "group" | "mpim" | "app_home";
  userId?: string;        // User who sent the message
  text: string;           // Message text content
  timestamp: string;      // Message timestamp
  threadTs?: string;      // Parent thread timestamp (if in thread)
  teamId?: string;        // Slack workspace ID
  isBot: boolean;         // Whether message is from a bot
  botId?: string;         // Bot ID (if from bot)
}
```

### Channel Filters

- `dm` - Direct messages only
- `channel` - Public channels only
- `group` - Private channels only
- `mpim` - Multi-party direct messages only
- `app_home` - App home tab only
- `all` - All channel types

### Conversation Workspace

The `atlas-conversation` workspace automatically handles Slack DMs and mentions:

```yaml
# Configured automatically in atlas-conversation workspace
signals:
  slack-dm:
    provider: slack
    config:
      events: [message]
      channels: [dm, channel]
      ignoreBotMessages: true
```

When messages match this signal, they're routed to the conversation agent which:
1. Maintains conversation history
2. Uses Slack MCP tools to send responses
3. Handles threading automatically
4. Supports emoji reactions

## Using Slack MCP Server

To send messages from your agents, configure the Slack MCP server:

```yaml
# workspace.yml
tools:
  mcp:
    servers:
      slack:
        transport:
          type: stdio
          command: npx
          args:
            - "-y"
            - "@modelcontextprotocol/server-slack"
        env:
          SLACK_BOT_TOKEN: auto        # Uses ATLAS_SLACK_BOT_TOKEN
          SLACK_TEAM_ID: auto          # Optional
        tools:
          allow:
            - slack_post_message       # Send messages
            - slack_reply_to_thread    # Reply in threads
            - slack_add_reaction       # Add emoji reactions
            - slack_get_channel_history
            - slack_get_user_info
```

### Example Agent

```yaml
agents:
  slack-responder:
    type: llm
    config:
      provider: anthropic
      model: claude-sonnet-4-5
      prompt: |
        When you receive a Slack message in the signal payload:
        1. Extract the channelId from the payload
        2. Use slack_post_message tool to respond
        3. If threadTs exists, use slack_reply_to_thread

        Slack formatting: *bold*, _italic_, `code`, ~strike~
```

## Troubleshooting

### Connection Failed

Check both tokens are set correctly:
```bash
echo $ATLAS_SLACK_APP_TOKEN  # Should start with xapp-1-
echo $ATLAS_SLACK_BOT_TOKEN  # Should start with xoxb-
```

### App Token Missing connections:write Scope

1. Go to your Slack app settings
2. Navigate to "Basic Information" → "App-Level Tokens"
3. Edit your token and ensure `connections:write` scope is added

### Events Not Received

1. Check Socket Mode is enabled in app settings
2. Verify Event Subscriptions are enabled
3. Check subscribed to correct bot events (message.im, message.channels)
4. Verify bot is installed in workspace
5. Check daemon logs for connection/routing errors

### Reconnection Issues

Socket Mode auto-reconnects with exponential backoff:
- Initial delay: 1 second
- Max delay: 30 seconds
- Check logs for "Slack Socket Mode disconnected" and reconnection attempts

### No Response from Bot

1. Verify `ATLAS_SLACK_BOT_TOKEN` is set
2. Check agent has Slack MCP server configured
3. Verify agent is using `slack_post_message` tool with correct channelId
4. Check daemon logs for signal trigger errors

## Comparison: Socket Mode vs Events API

| Feature | Socket Mode (Implemented) | Events API (Webhooks) |
|---------|--------------------------|----------------------|
| **Public URL required** | ❌ No | ✅ Yes |
| **Setup complexity** | ✅ Low | ❌ High |
| **Firewall friendly** | ✅ Outbound only | ❌ Inbound required |
| **Connection type** | WebSocket | HTTP |
| **Authentication** | App token + bot token | Signing secret + bot token |
| **Pattern match** | ✅ Same as Discord | ❌ Different |
| **Development** | ✅ Easy (no ngrok) | ❌ Harder |
| **Latency** | ✅ Lower | Higher |

**Why Socket Mode?**
- No need to expose Atlas to internet
- Better for development and internal deployments
- Matches Discord's Gateway pattern
- Simpler authentication

## Rate Limits

Socket Mode limits:
- Up to 10 concurrent WebSocket connections
- Events must be acknowledged within 3 seconds (handled automatically)
- Connection persists for hours, refreshes automatically

## Security

- **Token Authentication**: App-level token proves your app's identity
- **Envelope Acknowledgment**: Events must be acknowledged within 3 seconds
- **Automatic Reconnection**: Handles disconnects gracefully
- **No Public Endpoint**: No attack surface for webhooks

## Advanced Usage

### Custom Signal Routing

```yaml
signals:
  urgent-alerts:
    provider: slack
    config:
      events: [message]
      channels: [dm]              # DMs only
      ignoreBotMessages: true

  team-mentions:
    provider: slack
    config:
      events: [message]
      channels: [channel]         # Channels only
      ignoreBotMessages: false    # Include bot messages
```

### Thread Handling

The signal payload includes `threadTs` when a message is part of a thread. Use `slack_reply_to_thread` to maintain context:

```typescript
// In your agent logic
if (payload.threadTs) {
  // Reply in thread
  slack_reply_to_thread({
    channel: payload.channelId,
    thread_ts: payload.threadTs,
    text: "Response in thread"
  });
} else {
  // New message
  slack_post_message({
    channel: payload.channelId,
    text: "New message"
  });
}
```

## Implementation Details

### Package Structure

```
packages/slack/
├── src/
│   ├── schemas.ts              # Zod v4 event and Socket Mode schemas
│   ├── utils.ts                # Text processing utilities
│   ├── socket-client.ts        # WebSocket client (like Discord Gateway)
│   ├── event-router.ts         # Event routing logic
│   ├── registrar.ts            # Signal registration
│   ├── conversation-handler.ts # Conversation workspace routing
│   └── integration.ts          # Main orchestrator
└── mod.ts                      # Public exports
```

### Socket Mode Connection Flow

1. **Get WebSocket URL:**
   ```
   POST https://slack.com/api/apps.connections.open
   Authorization: Bearer xapp-1-...
   → Returns: wss://wss.slack.com/link/?ticket=...
   ```

2. **Connect to WebSocket:**
   ```
   Connect to wss://wss.slack.com/link/?ticket=...
   → Receive: {"type": "hello", ...}
   ```

3. **Receive Events:**
   ```
   ← {"type": "events_api", "envelope_id": "...", "payload": {...}}
   ```

4. **Acknowledge:**
   ```
   → {"envelope_id": "..."}
   ```

5. **Route to Signals:**
   ```
   Extract event → Match against registered signals → Trigger workspaces
   ```

### Conversation Flow

```
Slack Message → SlackSocketClient (receive via WebSocket)
    ↓
SlackEventRouter (match signals)
    ↓
Is conversation workspace? → YES → SlackConversationHandler
    ↓                                       ↓
    NO                           Transform to conversation-stream
    ↓                                       ↓
Direct signal trigger            Trigger conversation workspace
                                           ↓
                                 Conversation agent (with Slack MCP)
                                           ↓
                                 slack_post_message back to channel
```

### Conversation ID Format

Conversation IDs are deterministic for persistence:

```typescript
// DM or channel message
conversationId = `slack:${teamId}:${channelId}`

// Thread message
conversationId = `slack:${teamId}:${threadTs}`
```

This ensures:
- Same DM maintains conversation context
- Threads have separate conversations
- Conversations persist across daemon restarts

## Development

### Local Development

Socket Mode is perfect for local development - no ngrok or port forwarding needed!

```bash
# Set tokens
export ATLAS_SLACK_APP_TOKEN="xapp-1-..."
export ATLAS_SLACK_BOT_TOKEN="xoxb-..."

# Run daemon
deno task daemon
```

Atlas connects **to** Slack (outbound), not vice versa.

### Running Tests

```bash
deno task test packages/slack/
```

### Type Checking

```bash
deno check apps/atlasd/mod.ts
```

### Linting

```bash
deno task fmt
deno task biome
deno lint
```

## See Also

- [Slack Socket Mode Documentation](https://api.slack.com/apis/connections/socket-mode)
- [Slack MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/slack)
- [Atlas Signal Documentation](../../packages/config/src/signals.ts)
- [Discord Integration](../discord/README.md) - Similar WebSocket-based pattern
