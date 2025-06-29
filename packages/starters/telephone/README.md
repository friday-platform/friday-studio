# Telephone Game Workspace

This workspace demonstrates multi-agent sequential processing through a classic "telephone game"
where messages transform as they pass through different agents.

## Overview

The Telephone Game workspace showcases:

- Sequential agent execution
- Message transformation pipeline
- LLM agent coordination
- Signal-triggered workflows

## How It Works

1. **Trigger**: Send a message via the `telephone-message` signal
2. **Mishearing Agent**: Introduces phonetic errors and mishearings
3. **Embellishment Agent**: Adds creative details and context
4. **Reinterpretation Agent**: Dramatically transforms the meaning

## Usage

### 1. Configure API Keys

Edit the `.env` file and add your Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-api-key-here
```

### 2. Start the Atlas Daemon

```bash
atlas daemon start
```

### 3. Trigger the Telephone Game

```bash
atlas signal trigger telephone-message --data '{"message": "The quick brown fox jumps over the lazy dog"}'
```

### 4. Watch the Transformation

Monitor the session to see how your message transforms:

```bash
atlas ps  # List sessions
atlas logs <session-id> --follow
```

## Example Transformations

**Original**: "The quick brown fox jumps over the lazy dog"

**After Mishearing**: "The thick clown socks jump over the hazy fog"

**After Embellishment**: "In the misty morning, the portly circus performer's colorful striped socks
performed an impressive leap over the mysterious, swirling fog bank"

**After Reinterpretation**: "A fashion disaster at the circus leads to an unexpected weather
phenomenon when athletic wear gains sentience"

## Customization

### Modify Agent Behavior

Edit the system prompts in `workspace.yml` to change how agents transform messages:

```yaml
agents:
  mishearing-agent:
    system_prompt: |
      # Your custom mishearing rules here
```

### Add More Agents

Extend the pipeline by adding more transformation agents:

```yaml
execution:
  agents:
    - id: "mishearing-agent"
    - id: "translation-agent" # New agent
    - id: "embellishment-agent"
```

### Change Models

Try different models for varied results:

```yaml
agents:
  creative-agent:
    model: "claude-3-5-sonnet-20241022" # More creative
```

## Tips

- Keep initial messages under 200 characters for best results
- Try different types of messages: facts, stories, instructions
- Experiment with agent order for different effects
- Monitor performance with `atlas ps` during execution

## Next Steps

- Add more transformation agents
- Integrate external APIs for translation or analysis
- Create branching paths based on message content
- Build a web interface for easier interaction
