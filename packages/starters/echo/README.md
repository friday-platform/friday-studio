# Echo Workspace

A simple starter workspace that demonstrates the basics of Atlas - perfect for getting started with
AI agent orchestration.

## Overview

The Echo workspace is the simplest possible Atlas workspace that:

- Receives messages via CLI or HTTP signals
- Processes them with a single LLM agent
- Returns formatted responses
- Demonstrates basic workspace structure

## Quick Start

### 1. Configure API Keys

Edit the `.env` file and add your API key:

```bash
ANTHROPIC_API_KEY=your-api-key-here
```

### 2. Start Atlas

```bash
atlas daemon start
```

### 3. Send a Message

Via CLI:

```bash
atlas signal trigger echo --data '{"message": "Hello, Atlas!"}'
```

Via HTTP (if daemon is running on port 8080):

```bash
curl -X POST http://localhost:8080/signals/echo-http \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello via HTTP!"}'
```

### 4. View Results

```bash
atlas ps                    # List sessions
atlas logs <session-id>     # View session logs
```

## How It Works

1. **Signal Reception**: The workspace listens for `echo` or `echo-http` signals
2. **Agent Processing**: The echo-agent receives the message and formats a response
3. **Response**: The agent returns an acknowledged and formatted version of your message

## Customization Ideas

### 1. Change the Response Style

Edit the `system_prompt` in `workspace.yml`:

```yaml
agents:
  echo-agent:
    system_prompt: |
      You are a pirate echo bot.
      Echo messages back in pirate speak!
```

### 2. Add Message Validation

Add conditions to the job trigger:

```yaml
jobs:
  simple-echo:
    triggers:
      - signal: "echo"
        condition:
          and:
            - { var: "message" }
            - { ">": [{ "length": { "var": "message" } }, 5] }
```

### 3. Use a Different Model

Try different models for varied responses:

```yaml
agents:
  echo-agent:
    model: "gpt-4o-mini" # Requires OpenAI API key
```

## Learning Exercises

1. **Add Logging**: Modify the agent to log timestamps
2. **Multiple Agents**: Add a second agent that translates the echo
3. **Conditional Logic**: Echo differently based on message content
4. **External Tools**: Integrate an MCP server for additional capabilities

## Next Steps

Once comfortable with this echo workspace:

- Explore the `telephone` template for multi-agent workflows
- Check the `minimal` template for all configuration options
- Build your own custom workspace for your use case

## Troubleshooting

**No response?**

- Check API keys in `.env`
- Ensure daemon is running: `atlas daemon status`
- View daemon logs: `atlas daemon logs`

**Signal not found?**

- Verify signal name matches exactly
- Check workspace.yml syntax
- Run `atlas signal list` to see available signals
