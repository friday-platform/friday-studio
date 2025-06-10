# Telephone Game Workspace

A demonstration of Atlas AI agent orchestration where a message transforms through multiple agents,
similar to the classic "telephone game".

## Overview

This workspace shows how Atlas coordinates multiple AI agents in sequence with memory enhancement:

0. **Memory Agent (Load)** - Loads context and patterns from past sessions
1. **Mishearing Agent** - Introduces phonetic errors
2. **Embellishment Agent** - Adds narrative details
3. **Reinterpretation Agent** - Dramatically reimagines the story
4. **Memory Agent (Store)** - Stores session learnings for future improvement

## Quick Start

### 1. Setup Workspace

```bash
# Run the setup script
./setup-workspace.sh

# Or manually create workspace
deno task atlas workspace init
```

### 2. Configure API Key

Edit `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=your_actual_api_key_here
```

### 3. Start the Workspace Server

```bash
deno task atlas workspace serve
```

This starts the workspace server on http://localhost:8080

### 4. Send a Message

In another terminal:

```bash
# Using the CLI
deno task atlas signal trigger telephone-message --data '{"message": "The cat sat on the mat"}'

# Or using curl
curl -X POST http://localhost:8080/signals/telephone-message \
  -H "Content-Type: application/json" \
  -d '{"message": "The cat sat on the mat"}'
```

### 5. Monitor Progress

```bash
# List active sessions
deno task atlas ps

# View session details
deno task atlas logs <session-id>
```

## Example Transformation

```
Original: "The cat sat on the mat"
↓
Memory Load: "Based on past sessions, focus on creative sound changes and narrative expansion..."
↓
Mishearing: "The cat sat on the hat"  
↓
Embellishment: "The cat carefully sat on the old woolen hat that was left on the chair..."
↓
Reinterpretation: "The legendary feline warrior infiltrated the ancient fortress chair to claim the mystical Woolen Hat..."
↓
Memory Store: "Stored successful transformation patterns: sound substitution (mat→hat), narrative expansion (simple→detailed), genre shift (realistic→fantasy)"
```

## Project Structure

```
telephone/
├── agents/                    # Agent implementations
│   ├── memory-agent.ts       # Memory management (load/store)
│   ├── mishearing-agent.ts
│   ├── embellishment-agent.ts
│   └── reinterpretation-agent.ts
├── workspace.yml             # Workspace configuration
├── setup-workspace.sh        # Quick setup script
├── .env                      # API keys (create from .env.example)
└── .atlas/                   # Runtime data (gitignored)
    └── memory/               # CoALA memory storage by type
        ├── working.json      # Short-term working memory
        ├── episodic.json     # Specific session experiences
        ├── semantic.json     # General knowledge patterns
        ├── procedural.json   # Transformation techniques
        ├── contextual.json   # Session-specific context
        └── index.json        # Memory statistics and overview
```

## Configuration

The `workspace.yml` file defines:

- **Supervisor prompts** - Instructions for the AI coordinator
- **Agent mappings** - Which agents process which signals
- **Evaluation criteria** - When the session is complete
- **Server settings** - Port, logging, etc.

## How It Works

1. **Signal Triggered** - You send a message via CLI or HTTP
2. **Supervisor Plans** - AI supervisor creates execution plan with memory context
3. **Memory Load** - Memory agent loads relevant patterns from past sessions
4. **Agents Execute** - Each agent transforms the message in sequence
5. **Progress Tracked** - Supervisor ensures all agents run successfully
6. **Memory Store** - Memory agent extracts and stores session learnings
7. **Summary Generated** - AI summarizes the transformation chain with insights

## Customization

To modify the transformation chain:

1. Edit agent prompts in `agents/*.ts`
2. Update supervisor prompts in `workspace.yml`
3. Add new agents and update mappings
4. Restart the workspace server

## Troubleshooting

- **"No workspace.yml found"** - Run from the telephone directory
- **"Session ended early"** - Check evaluation prompts in workspace.yml
- **"Agent not transforming"** - Verify API key and model availability
