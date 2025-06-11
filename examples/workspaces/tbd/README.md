# TBD (To Be Determined) Workspace

A demonstration of Atlas AI agent orchestration with continuous learning capabilities. This
workspace provides helpful assistance while learning from every interaction to improve over time.

## Overview

This workspace shows how Atlas coordinates AI agents with memory enhancement:

0. **Memory Agent (Load)** - Loads context and patterns from past user interactions
1. **TBD Agent** - Provides helpful assistance for questions and tasks
2. **Memory Agent (Store)** - Stores session learnings for continuous improvement

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
deno task atlas signal trigger tbd-message --data '{"message": "How do I learn TypeScript?"}'

# Or using curl
curl -X POST http://localhost:8080/signals/tbd-message \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I learn TypeScript?"}'
```

### 5. Monitor Progress

```bash
# List active sessions
deno task atlas ps

# View session details
deno task atlas logs <session-id>
```

## Example Interaction

```
User Request: "How do I learn TypeScript?"
↓
Memory Load: "Based on past interactions, users prefer structured learning paths with hands-on examples..."
↓
TBD Agent: "Here's a comprehensive TypeScript learning path:
1. Start with JavaScript fundamentals if needed
2. Learn TypeScript basics (types, interfaces, generics)
3. Practice with small projects
4. Explore advanced features (decorators, modules)
5. Build a real application

Recommended resources: TypeScript Handbook, exercises on TypeScript playground..."
↓
Memory Store: "Stored successful response pattern: structured learning paths, practical examples, specific resources. User satisfied with comprehensive guidance."
```

## Project Structure

```
tbd/
├── agents/                    # Agent implementations
│   ├── memory-agent.ts       # Memory management (load/store)
│   └── tbd-agent.ts          # Helpful assistant
├── workspace.yml             # Workspace configuration
├── setup-workspace.sh        # Quick setup script
├── .env                      # API keys (create from .env.example)
└── .atlas/                   # Runtime data (gitignored)
    └── memory/               # CoALA memory storage by type
        ├── working.json      # Short-term working memory
        ├── episodic.json     # User interaction history
        ├── semantic.json     # Knowledge topics and facts
        ├── procedural.json   # Response techniques
        ├── contextual.json   # User preferences
        └── index.json        # Memory statistics
```

## Configuration

The `workspace.yml` file defines:

- **Supervisor prompts** - Instructions for the AI coordinator
- **Agent mappings** - Which agents process which signals
- **Evaluation criteria** - When the session is complete
- **Server settings** - Port, logging, etc.

## How It Works

1. **Signal Triggered** - You send a request via CLI or HTTP
2. **Supervisor Plans** - AI supervisor creates execution plan with memory context
3. **Memory Load** - Memory agent loads relevant patterns from past interactions
4. **TBD Agent Responds** - Provides helpful response informed by memory context
5. **Memory Store** - Memory agent extracts and stores session learnings
6. **Continuous Improvement** - Each interaction improves future responses

## Customization

To modify the assistant behavior:

1. Edit agent prompts in `agents/*.ts` to change response style
2. Update supervisor prompts in `workspace.yml` for different coordination
3. Modify memory agent categories to store different types of insights
4. Add new agents and update mappings for extended functionality
5. Restart the workspace server

## Memory Learning

The workspace continuously learns from:

- **User Questions** - Common topics and question patterns
- **Response Quality** - What approaches work best
- **User Preferences** - Communication styles and information depth
- **Knowledge Domains** - Areas of expertise frequently requested
- **Interaction Patterns** - Successful conversation flows

## Troubleshooting

- **"No workspace.yml found"** - Run from the tbd directory
- **"Session ended early"** - Check evaluation prompts in workspace.yml
- **"Agent not responding"** - Verify API key and model availability
- **"Memory not loading"** - Check .atlas/memory/ directory permissions
