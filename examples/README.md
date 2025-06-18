# Atlas Examples

This directory contains example workspaces, agents, and demonstrations of Atlas functionality.

## Example Agents

### EchoAgent (`agents/echo-agent.ts`)

Simple agent that echoes messages back with elaboration. Demonstrates:

- Basic agent implementation
- Streaming response functionality
- Message history tracking

### LLMAgent (`agents/llm-agent.ts`)

Template for real LLM integration. Shows how to:

- Configure different LLM providers (OpenAI, Anthropic, Google)
- Handle streaming responses from LLMs
- Mock responses for testing without API keys

### ClaudeAgent (`agents/claude-agent.ts`)

Real Claude integration using Anthropic's API. Demonstrates:

- Actual LLM API calls with streaming
- Environment variable configuration
- Production-ready agent implementation

## Examples

### Basic Example (`example.ts`)

Demonstrates core Atlas functionality:

- Creating workspaces
- Adding signals
- Session processing
- Workspace persistence

```bash
deno task atlas workspace serve --workspace examples/
```

### Streaming Example (`example-streaming.ts`)

Shows agent streaming capabilities:

- Real-time response streaming
- Agent interaction patterns
- Both streaming and non-streaming modes

```bash
deno task atlas tui --workspace examples/
```

### Claude Example (`example-claude.ts`)

Real Claude AI integration:

- Actual Claude API calls
- Environment variable setup
- Production LLM streaming

```bash
# First, copy .env.example to .env and add your ANTHROPIC_API_KEY
cp .env.example .env

# Then run the example
deno task atlas workspace serve --workspace examples/
```

## Workspace Examples

### Ready-to-Use Workspaces (`workspaces/`)

#### 1. Telephone Game (`workspaces/telephone/`)

A fun demonstration where messages transform through multiple agents:

```bash
cd examples/workspaces/telephone
deno task atlas workspace serve

# In another terminal
deno task atlas signal trigger telephone-message --data '{"message": "The cat sat on the mat"}'
```

**Features:**

- Sequential agent execution
- Message transformation pipeline
- Supervisor coordination
- Beautiful CLI monitoring

#### 2. Basic Chat (`workspaces/basic-chat/`)

Simple conversational agent:

```bash
cd examples/workspaces/basic-chat
./setup.sh && ./test.sh
```

#### 3. Dev Team (`workspaces/dev-team/`)

Simulated development team with specialized agents:

```bash
cd examples/workspaces/dev-team
./setup.sh && ./test.sh
```

**Test all workspaces:**

```bash
cd examples/workspaces
./test-all.sh
```

## Code Examples

From the project root:

```bash
# Basic Atlas functionality
deno task atlas workspace serve --workspace examples/

# Streaming agents
deno task atlas tui --workspace examples/
```

## Creating Custom Agents

1. Extend `BaseAgent` from `../src/core/agents/base-agent.ts`
2. Implement required methods: `name()`, `purpose()`, `invokeStream()`
3. Add to workspace and test

See existing example agents for reference patterns.
