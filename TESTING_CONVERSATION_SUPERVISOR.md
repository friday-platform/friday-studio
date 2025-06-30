# Testing ConversationSupervisor with Context & Workspace Creation

## Setup Instructions for Michal

### 1. Prerequisites

- Ensure you have Deno installed
- Set your Anthropic API key as an environment variable:
  ```bash
  export ANTHROPIC_API_KEY=your-api-key-here
  ```

### 2. Pull the Latest Changes

```bash
git checkout conversational-ux
git pull origin conversational-ux
```

### 3. Start the Atlas Daemon

In one terminal window:

```bash
deno task atlas daemon start
```

### 4. Run the Conversation Client

In another terminal window:

```bash
deno task atlas cx
```

## What's New

### 1. **Context Preservation**

The ConversationSupervisor now maintains conversation history within a session. Try this:

```
User: help me create a workspace for bug detection
Assistant: [responds with context]
User: can you call it bugfinder instead?
Assistant: [should remember the previous conversation and understand "it" refers to the workspace]
```

### 2. **Real Workspace Creation**

The supervisor now actually creates workspaces via the daemon API. Try:

```
User: create a bare workspace called test-workspace
```

Then verify it was created:

```bash
# In another terminal
deno task atlas workspaces
```

The workspace should appear in the list with a unique ID like "caramel_wheat".

### 3. **Tool Usage**

The ConversationSupervisor now has two tools:

- `cx_reply`: For communicating with users
- `workspace_create`: For actually creating workspaces

When you ask to create a workspace, watch for the tool calls in the output - it should call both
tools.

## Testing Scenarios

### Test 1: Context Retention

1. Start a conversation about creating a workspace
2. Ask follow-up questions using pronouns like "it" or "that"
3. Verify the assistant maintains context

### Test 2: Workspace Creation

1. Ask to create a workspace with a specific name
2. Check that it actually creates the workspace (not just pretends)
3. Verify the workspace appears in `deno task atlas workspaces`

### Test 3: Error Handling

1. Try to create a workspace with an invalid name (e.g., with spaces)
2. Try to create a duplicate workspace name
3. Verify appropriate error messages

## Known Limitations

1. **Session-based Memory**: Context is only maintained within a session. If you restart the cx
   client, conversation history is lost.

2. **No Cross-Session Memory**: Each session starts fresh. Full CoALA memory integration (see
   CONVERSATION_MEMORY_TASK.md) would fix this.

3. **Basic Workspace Creation**: Currently only creates basic workspaces with name/description.
   Advanced configuration still needs manual editing.

## Debug Logs

To see detailed logs:

```bash
# Set log level to debug
export ATLAS_LOG_LEVEL=debug
deno task atlas cx
```

This will show:

- Tool calls being made
- Conversation history being included
- API calls to create workspaces
- Any errors or issues

## Common Issues

1. **"No tools called"**: If you see this, the LLM didn't use any tools. The system prompt should
   force tool usage now.

2. **Workspace not appearing**: Check that the daemon is running and accessible on port 8080.

3. **Context still lost**: Make sure you're testing within the same session. Opening a new cx client
   starts a new session.

## Next Steps

The quick fix implemented here solves the immediate context loss issue. For production use, we
should implement the full CoALA memory integration described in CONVERSATION_MEMORY_TASK.md, which
would:

- Persist conversations across daemon restarts
- Enable semantic search across past conversations
- Build up knowledge about user preferences
- Share learning between sessions
