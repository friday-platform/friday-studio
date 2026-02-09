# Discord Integration

Discord bot integration for Atlas using Gateway WebSocket and HTTP interaction
endpoints. Enables natural messaging, slash commands, and workspace signal
triggering.

## Overview

Atlas integrates with Discord via **dual-mode architecture**:

- **Gateway WebSocket**: Receives message events (DMs, @mentions, server
  messages)
- **HTTP Interactions**: Processes slash commands and button clicks
- **Event-based signals**: Route Discord messages to workspace signals
- **Streaming chat**: Real-time conversation responses with rate limiting
- **Button interactions**: "Continue in DM" button for seamless transition

**Architecture:** Gateway (WebSocket) + HTTP webhooks. Natural messaging via
events, commands via HTTP.

## Features

### Natural Messaging (Gateway WebSocket)

- **Direct Messages**: Send DMs to bot, get responses
- **@Mentions**: @mention bot in server channels
- **Event-based signals**: Configure which messages trigger which signals
- **Channel filtering**: DM-only, @mention-only, guild-only, or all
- **Guild restrictions**: Limit signals to specific servers (optional)

### Slash Commands (HTTP Interactions)

- `/atlas ping` - Check bot status
- `/atlas workspaces` - List available workspaces
- `/atlas chat <message>` - Start streaming conversation with "Continue in DM"
  button

### Button Interactions

- **"Continue in DM" button**: Added after `/atlas chat` responses
- Click to open DM channel automatically
- Seamless transition from server to private conversation

### Streaming Chat

- Persistent chat history (per user per channel)
- Real-time response streaming via SSE
- Discord rate limit compliance (5 messages per 5 seconds)
- Deterministic chat IDs for conversation continuity

### Security

- Ed25519 signature verification on all interactions
- MESSAGE_CONTENT privileged intent (required for message events)
- Environment-based secrets
- Error message sanitization
- Bot message filtering (prevents loops)

## Architecture

### Components

```
Discord Gateway (WebSocket)          Discord API (HTTP)
    ↓ MESSAGE_CREATE                      ↓ Slash commands/Buttons
DiscordGateway                        DiscordInteractionHandler
    ↓                                     ↓
DiscordEventRouter  ←─────────────────────→ DiscordIntegration (orchestrator)
    ↓
WorkspaceSignalTrigger
```

**DiscordIntegration** (`discord-integration.ts`)

- Self-contained integration class
- Loads configuration from environment
- Creates and manages all Discord components
- Provides HTTP handler for webhook endpoint
- Connects Gateway WebSocket on startup

**DiscordGateway** (`discord-gateway.ts`)

- WebSocket connection to Discord Gateway
- Listens for MESSAGE_CREATE and MESSAGE_UPDATE events
- Emits events to DiscordEventRouter
- Handles reconnection and errors

**DiscordEventRouter** (`discord-event-router.ts`)

- Routes Gateway events to workspace signals
- Filters bot messages (prevents loops)
- Detects DM, @mention, and guild messages
- Matches events to signal configurations
- Builds signal payloads with Discord metadata

**DiscordCommandRegistrar** (`discord-command-registrar.ts`)

- Registers `/atlas` commands via Discord REST API
- Global command registration (takes ~1 hour to propagate)
- Health check for command availability

**DiscordInteractionHandler** (`discord-interaction-handler.ts`)

- Processes incoming HTTP interactions
- Ed25519 signature verification
- Routes commands (ping, workspaces, chat)
- Handles button clicks ("Continue in DM")
- Manages chat streaming

**DiscordSignalRegistrar** (`signal-registrars/discord-registrar.ts`)

- Tracks workspace Discord signals
- Stores event configurations
- Matches Gateway events to signal configs
- Provides validation and lookup

**DiscordConversationHandler** (`discord-conversation-handler.ts`)

- Handles streaming conversations for friday-conversation workspace
- Shows typing indicators during processing
- Accumulates streaming responses and sends to Discord
- Provides Discord-specific UX features

## Configuration

### Environment Variables (Required)

```bash
# Discord Bot Token
ATLAS_DISCORD_BOT_TOKEN="MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXX.XXXXXXXXXXXXXXX"

# Discord Application ID
ATLAS_DISCORD_APPLICATION_ID="1234567890123456789"

# Discord Public Key (for signature verification)
ATLAS_DISCORD_PUBLIC_KEY="abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
```

### Getting Discord Credentials

1. Visit https://discord.com/developers/applications
2. Create new application
3. **Bot** tab → Copy token → `ATLAS_DISCORD_BOT_TOKEN`
4. **Bot** tab → Enable **MESSAGE CONTENT INTENT** (privileged intent -
   required!)
5. **General Information** → Application ID → `ATLAS_DISCORD_APPLICATION_ID`
6. **General Information** → Public Key → `ATLAS_DISCORD_PUBLIC_KEY`
7. **OAuth2** → URL Generator:
   - Scopes: `applications.commands` + `bot`
   - Permissions: Send Messages, View Channels (minimum)
8. Use generated URL to invite bot to server

**⚠️ MESSAGE CONTENT INTENT Required:**

- Enables bot to read message content from Gateway
- Required for natural messaging (DMs, @mentions)
- For bots in 100+ servers, Discord verification required

### Interaction Endpoint Setup

**Requirement:** Discord must reach your daemon via HTTPS.

**Local Development:**

```bash
# Option 1: ngrok
ngrok http 8080
# Copy HTTPS URL

# Option 2: cloudflared
cloudflared tunnel --url http://localhost:8080
# Copy HTTPS URL
```

**Configure in Discord Portal:**

1. Developer Portal → Your App → General Information
2. Interactions Endpoint URL: `https://your-url.ngrok.io/discord/interactions`
3. Save (Discord will send test interaction to verify)

### Workspace Configuration

**Event-based Signal (Natural Messaging):**

```yaml
version: "1.0"

workspace:
  name: my-bot
  description: "Discord-triggered workspace"

signals:
  discord-dm:
    provider: discord
    description: "Respond to DMs and @mentions"
    config:
      events: [message_create] # message_create, message_update
      channels: [dm, mention] # dm, mention, guild, all
# allowedGuilds: ["123..."]    # Optional: restrict to specific servers

jobs:
  respond:
    description: "Respond to Discord messages"
    triggers:
      - signal: discord-dm
    execution:
      strategy: sequential
      agents:
        - id: responder

agents:
  responder:
    type: llm
    config:
      provider: anthropic
      model: claude-sonnet-4-5
      prompt: "You are a helpful bot. Respond to the user's message."
```

**How it works:**

- User sends DM or @mentions bot
- Gateway receives MESSAGE_CREATE event
- Event router matches event to `discord-dm` signal (channels: [dm, mention])
- Signal triggers `respond` job
- Agent processes message and responds

**Signal Payload Structure:**

When triggered, signals receive Discord metadata:

```typescript
{
  message: string,                   // Message content
  eventType: "message_create" | "message_update",

  _discord: {
    guildId: string | null,          // Server ID (null for DMs)
    channelId: string,               // Channel ID
    userId: string,                  // User who sent message
    username: string,                // Username
    discriminator: string,           // User discriminator
    timestamp: string,               // ISO timestamp
    interactionId: string,           // Message ID
    interactionToken: string         // Empty for Gateway events
  }
}
```

## Usage

### Natural Messaging

After setup with MESSAGE_CONTENT intent enabled:

```
User sends DM: "Hey, can you help me?"
→ Bot receives via Gateway, triggers signal, responds naturally

User in server: "@BotName what's the status?"
→ Bot detects @mention, triggers signal, responds

User edits message: "Actually, I meant..."
→ Bot receives MESSAGE_UPDATE (if configured), can react to edits
```

### Slash Commands

Test commands in Discord:

```
/atlas ping
→ Shows bot status, workspace count, Gateway connection

/atlas workspaces
→ Lists all workspaces (shows 🎮 for Discord-enabled)

/atlas chat Hello!
→ Streams conversation response
→ Shows "Continue in DM" button after completion
```

### Button Interactions

```
User: /atlas chat Can you help me with something?
Bot: [streams response]
     [Shows "Continue in DM" button]

User: [clicks button]
Bot: Opens DM, sends "👋 Hi! You can send me messages here..."
     Updates original: "✅ Check your DMs!"
```

### Conversation Flow

```
# Via slash command
User: /atlas chat How do I create a workspace?
Bot: [streams response in real-time]
     [Shows "Continue in DM" button]

# Via natural DM (after clicking button or sending directly)
User: Can you show an example?
Bot: [receives via Gateway, responds naturally]

User: What about signals?
Bot: [loads previous context, responds]
```

Each user gets persistent chat history per channel.

### Chat ID Generation

Deterministic chat IDs enable conversation continuity:

- **Format:** `discord-{userId}-{channelId}`
- **DMs:** `discord-dm-{userId}-{channelId}`
- **Server channels:** `discord-{guildId}-{channelId}-{userId}`

## Troubleshooting

### "Discord integration disabled (missing configuration)"

Check all 3 environment variables are set:

```bash
echo $ATLAS_DISCORD_BOT_TOKEN
echo $ATLAS_DISCORD_APPLICATION_ID
echo $ATLAS_DISCORD_PUBLIC_KEY
```

### "Invalid signature" (401)

- Verify `ATLAS_DISCORD_PUBLIC_KEY` matches Discord portal
- Check for extra whitespace in environment variable
- Ensure daemon is running when Discord sends test interaction

### Commands not appearing

- Global commands take ~1 hour to propagate
- Check Discord portal → Your App → Commands
- Verify bot has `applications.commands` scope
- Try reinviting bot with correct scopes

### Gateway not connecting

- Check MESSAGE_CONTENT intent is enabled in Discord portal
- Verify bot token is correct (`ATLAS_DISCORD_BOT_TOKEN`)
- Check daemon logs for "Discord Gateway connected successfully"
- If bot is in 100+ servers, Discord verification required for intent

### Messages not triggering signals

- Verify MESSAGE_CONTENT intent enabled
- Check signal configuration matches event criteria
- Ensure `channels` filter includes correct type (dm/mention/guild/all)
- Check daemon logs: "Triggering Discord signals from message"
- Bot's own messages are always ignored (prevents loops)

## Current Limitations

### Response Mechanism (Phase 2)

**Current:** Signals triggered but responses not automatically sent back

- ✅ Gateway receives messages and triggers signals
- ✅ Event routing works correctly
- ❌ No automatic response mechanism for Gateway events
- ✅ Workaround: Use `/atlas chat` (has full streaming support)

**How to respond to natural messages:**

1. Use Discord MCP server tool in agents
2. Agent uses `discord_send_message` tool to reply
3. Requires Discord MCP server configured in workspace

**Example:**

```yaml
tools:
  mcp:
    servers:
      discord:
        command: "deno"
        args: ["run", "-A", "path/to/discord-mcp-server.ts"]
        env:
          DISCORD_BOT_TOKEN: "${ATLAS_DISCORD_BOT_TOKEN}"
```

### Access Control (Partial)

**Implemented:**

- ✅ Guild restrictions (`allowedGuilds`)
- ✅ Channel filtering (dm/mention/guild/all)

### Command Propagation

- Global commands take ~1 hour to appear
- 200 command registrations per day limit
- Cannot instant-update commands

## Development

### Running Daemon with Discord

```bash
# Set environment variables
export ATLAS_DISCORD_BOT_TOKEN="your-token"
export ATLAS_DISCORD_APPLICATION_ID="your-app-id"
export ATLAS_DISCORD_PUBLIC_KEY="your-public-key"

# Expose daemon (local dev)
ngrok http 8080 &

# Start daemon
deno task atlas daemon

# Check logs for "Discord integration ready"
```

### File Structure

```
packages/discord/src/
├── integration.ts                 # Integration orchestrator
├── gateway.ts                     # Gateway WebSocket connection
├── event-router.ts                # Routes Gateway events to signals
├── command-registrar.ts           # Command registration
├── interaction-handler.ts         # HTTP request handler + button clicks
├── conversation-handler.ts        # Streaming conversation handler (friday-conversation)
├── registrar.ts                   # Signal tracking + event matching
├── schemas.ts                     # Zod schemas (interactions, messages, buttons)
└── utils.ts                       # Shared utilities

packages/config/src/
└── signals.ts                     # Discord signal schema (event config)
```

### Testing

```bash
# Type check
deno check apps/atlasd/src/discord/**/*.ts

# Lint
deno task lint

# Format
deno task fmt
```

## Technical Decisions

### Why Dual-Mode Architecture?

**Gateway WebSocket + HTTP Interactions:**

- ✅ Natural messaging via Gateway (DMs, @mentions)
- ✅ Slash commands via HTTP (better UX for explicit actions)
- ✅ Button interactions via HTTP (state updates)
- ✅ Best of both worlds

**Gateway alone would mean:**

- ❌ No slash commands (less discoverable)
- ❌ No button interactions
- ❌ Everything must be natural language

**HTTP alone would mean:**

- ❌ No natural messaging
- ❌ Users forced to use commands

### Why Event-Based Signals?

**Event configuration over custom commands:**

- ✅ More flexible (filter by DM, @mention, guild)
- ✅ Natural UX (just send messages)
- ✅ No command name collisions
- ✅ Works with any message content
- ❌ Requires MESSAGE_CONTENT privileged intent

**Previous approach (custom commands):**

- Auto-generated `/{jobname}-{workspacename}` commands
- Hit Discord's 200 command/day limit
- Less natural for conversation
- Removed in Phase 2 refactor

### Why Deterministic Chat IDs?

**Format: `discord-{guildId}-{channelId}-{userId}`**

- ✅ Persistent conversations per user per channel
- ✅ No database needed for session management
- ✅ Natural continuation of conversations
- ✅ Idempotent (same input = same chat ID)
- ✅ Works across slash commands and natural messages

## API Reference

### DiscordIntegration

```typescript
class DiscordIntegration {
  async initialize(
    signalRegistrar: DiscordSignalRegistrar,
    workspaceManager: WorkspaceManager,
    onWakeup: WorkspaceSignalTriggerCallback,
    getOrCreateRuntime: (workspaceId: string) => Promise<WorkspaceRuntime>,
  ): Promise<void>;

  async registerCommands(
    signalRegistrar: DiscordSignalRegistrar,
  ): Promise<void>;

  getHttpHandler(): Hono | null;

  shutdown(): void;

  isReady(): boolean;
}
```

### Signal Configuration Schema

```typescript
{
  provider: 'discord',
  description: string,
  config: {
    // Events to listen for (required)
    events: ('message_create' | 'message_update')[],

    // Channel filters (required)
    channels: ('dm' | 'mention' | 'guild' | 'all')[],

    // Optional guild restrictions
    allowedGuilds?: string[],
  }
}
```

**Channel Filter Behavior:**

- `dm`: Only direct messages
- `mention`: Only @mentions of bot
- `guild`: Only guild messages (non-DM)
- `all`: All messages (DMs + guild)

**Event Types:**

- `message_create`: New messages
- `message_update`: Edited messages

## References

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord Interactions Documentation](https://discord.com/developers/docs/interactions/receiving-and-responding)
- [Discord Slash Commands](https://discord.com/developers/docs/interactions/application-commands)
- [@discordjs/rest Documentation](https://discord.js.org/docs/packages/rest/main)

## Implementation Status

### ✅ Completed (Phase 1)

- **Gateway WebSocket connection**
  - MESSAGE_CREATE and MESSAGE_UPDATE event handling
  - Auto-reconnection and error handling
  - MESSAGE_CONTENT intent support

- **Event-based signal routing**
  - Channel filtering (dm/mention/guild/all)
  - Event type filtering (message_create/message_update)
  - Guild restrictions (allowedGuilds)
  - @mention detection
  - Bot message filtering

- **Slash commands**
  - `/atlas ping`, `/atlas workspaces`, `/atlas chat`
  - Global command registration
  - Health checking

- **Button interactions**
  - "Continue in DM" button on `/atlas chat`
  - Opens DM channel automatically
  - Updates original message

- **Removed complexity**
  - Removed custom command generation
  - Simplified to event-driven model
  - Clean architecture separation

### ⏸️ Future Enhancements (Phase 2)

**Response Mechanism:**

- Discord MCP server for agent responses
- Automatic response to Gateway events
- Complete natural conversation loop (currently requires manual MCP tool usage)

**Access Control:**

- Per-user permissions
- Rate limiting per user

**Enhanced Interactions:**

- Select menus for complex inputs
- Modal dialogs for forms
- Rich embeds for responses
- Message reactions
