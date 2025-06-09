# Basic Chat Workspace

Simple Atlas workspace for testing basic agent interaction.

## What This Example Demonstrates

- Creating a workspace
- Adding an echo agent
- Basic chat interaction with streaming responses
- Agent persistence and loading

## Setup

```bash
./setup.sh
```

This will:

1. Create a new workspace called "basic-chat-demo"
2. Add an echo agent to the workspace
3. Display workspace and agent IDs for testing

## Testing

```bash
./test.sh
```

This will run several test conversations with the echo agent to verify everything works.

## Manual Testing

After running setup, you can manually chat with the agent:

```bash
# Use the workspace and agent IDs from setup output
atlas chat --message "Hello Atlas!" --workspace <workspace-id> --agent <agent-id>
```

## Expected Behavior

The echo agent will:

- Repeat your message
- Add elaboration about the message
- Stream the response in real-time chunks
- Keep message history in the workspace

## Troubleshooting

If chat fails:

1. Verify workspace exists: `atlas workspace list`
2. Verify agent exists: `atlas agent list`
3. Check that workspace and agent IDs match setup output
