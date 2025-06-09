# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

**Atlas** is a comprehensive AI agent orchestration platform that transforms software delivery
through human/AI collaboration. Atlas enables engineers to create workspaces where humans
collaborate seamlessly with specialized, autonomous agents in a secure, auditable, and scalable
environment.

## Claude Code execution guidelines

1. Use `deno check` to statically verify code validity before running
2. Run with required Deno flags:
   `--unstable-broadcast-channel --unstable-worker-options --allow-all --env-file`
3. Ensure `ANTHROPIC_API_KEY` is set in .env file for LLM functionality
4. When debugging worker communication, check logs in `~/.atlas/logs/workspaces/`

## Vision & Goals

Transform software delivery into an AI-native process by building a system that orchestrates the
lifecycle, state, memory, and communication between multiple AI agents, humans, and pre-defined
deterministic workflows.

## First Principles

Atlas is built on fundamental assumptions about the AI landscape:

1. **AI Rapid Growth**: The AI landscape will grow rapidly across models, tooling, and applications
2. **Developer Traction**: Broad traction for AI as coding agents among software developers is
   proven
3. **Operations Gap**: Software delivery & cloud operations AI adoption lags behind coding
4. **Deployment Constraints**: While code implementation is flexible, deployment environments are
   fixed specifications
5. **Agent Availability**: Artificial agents can produce and refine indefinitely (barring cost),
   unlike humans
6. **Functional Determinism**: LLMs can achieve functional determinism via model, weights, prompt,
   controlled sampling and hardware
7. **Token-Based Output**: LLM output is fundamentally a sequence of tokens
8. **Emergent Capabilities**: LLMs have rapidly evolving emergent capabilities

## System Principles

### Core Architecture Principles

1. **Enhanced Performance**: LLMs perform better with more training, memory, and context
2. **Stateless Agents**: Agents are stateless; memory/context/scratchpad are retrieved or ephemeral
3. **Actor System**: Workspaces are actor systems where each actor represents an agent
4. **Workspace Supervision**: Each workspace has a top-level WorkspaceSupervisor for configuration
   and lifecycle management
5. **Signal Processing**: External events (Signals) can be added to workspaces with optional
   conditions, filters, or aggregation
6. **Independent Signal Processing**: Each Signal processed independently with configurable
   idempotency
7. **Session Isolation**: Each Signal spawns a WorkspaceSession with unique context (like "New
   Chat")
8. **Configuration-Driven**: WorkspaceSession reads WorkspaceConfiguration and spawns
   WorkspaceAgents
9. **Concurrent Sessions**: Multiple sessions may be active based on workspace signal configuration
10. **Manual Testing**: Signals should be manually triggerable for testing

### Agent & Memory Management

11. **Configurable Signals**: Signals configurable via workspace-specific prompts or client
    configuration
12. **Agent Instances**: WorkspaceAgent is an instance of an AtlasAgent running in isolated worker
13. **Stateless Actors**: Agents are stateless; context/memory provided by supervisors before
    invocation
14. **Layered Prompting**: Agents may have prompts at agent, organization, workspace, signal, and
    mapping levels
15. **Full Observability**: All workspace components should be observed and traced
16. **Attribution & Audit**: All mutations and invocations attributed and audit logged
17. **Cost Tracking**: All cost-generating factors tracked
18. **External Memory**: Memory stored externally, not in agent instances
19. **Hierarchical Access**: WorkspaceSupervisor sees all, SessionSupervisor sees session, Agents
    see filtered view

### Workspace Configuration

20. **Multi-Component Workspaces**: Workspaces configure Signals, Agents, Mappings, Workflows,
    People, and Taxonomy
21. **Global Visibility**: WorkspaceSupervisor has full visibility on all workspace components
22. **Agent Communication**: Agent-to-Agent communication via BroadcastChannels and supervisor
    mediation
23. **Built-in Workflows**: Default workflows available (Gates, Built-in signals)
24. **Signal-Agent Mappings**: Declarative M:M configuration between signals and agents with
    conditions
25. **YAML/JSON Serializable**: Full workspace configuration can be serialized and version
    controlled

## Core Architecture

### Atlas Scopes

Hierarchical containers that encapsulate context, memory, and conversation for AI-powered use cases.
Create a call stack for context, memory, and messages. Each scope inherits from its parent but
maintains isolation.

### Hierarchical Supervisor Architecture

The system implements a three-tier supervision hierarchy with LLM intelligence at each level:

1. **WorkspaceRuntime**: Orchestration layer that:
   - Manages the overall workspace lifecycle
   - Spawns and monitors WorkspaceSupervisor
   - Handles signal routing and session tracking
   - Integrates with WorkerManager for process isolation

2. **WorkspaceSupervisor**: Root LLM-enabled agent with XState FSM that:
   - Holds global workspace context/memory/messaging
   - **Analyzes signals using LLM** to understand intent and goals
   - **Creates filtered session contexts** based on signal analysis
   - Spawns SessionSupervisors with relevant subset of workspace data
   - Manages signal-to-agent mappings dynamically
   - Coordinates multiple concurrent sessions

3. **SessionSupervisor**: LLM-enabled session coordinator that:
   - Receives filtered context from WorkspaceSupervisor
   - **Creates dynamic execution plans** using LLM reasoning
   - Determines agent selection, order, and data flow
   - Spawns and coordinates AgentWorkers
   - **Evaluates progress** and adapts strategy as needed
   - Supports iterative refinement loops

4. **Agents**: Stateless executors that:
   - Run in isolated AgentWorkers extending BaseWorker FSM
   - Receive specific task context from SessionSupervisor
   - Execute tasks without broader awareness
   - Communicate via BroadcastChannels (session-wide) and MessagePorts (direct)
   - Return raw outputs for supervisor evaluation

### Signal Processing & Session Lifecycle

1. **Signal Reception**: WorkspaceRuntime receives signal
2. **Signal Analysis**: WorkspaceSupervisor uses LLM to analyze signal intent
3. **Context Filtering**: WorkspaceSupervisor creates session-specific context
4. **Session Creation**: SessionSupervisor spawned with filtered context
5. **Execution Planning**: SessionSupervisor creates execution plan via LLM
6. **Agent Orchestration**: Agents execute based on plan
7. **Result Evaluation**: SessionSupervisor evaluates and may refine
8. **Completion**: Results returned through supervisor hierarchy

### Worker Communication Architecture

- **WorkerManager**: Central orchestrator for all worker processes
- **BroadcastChannels**: Session-wide event broadcasting
- **MessagePorts**: Direct worker-to-worker communication
- **Isolation**: Each worker runs in separate Deno Web Worker

### Worker Architecture

- **BaseWorker**: XState FSM foundation (uninitialized → initializing → ready → busy → terminated)
- **WorkerManager**: Orchestrates worker lifecycle with XState FSM
- **Communication**: BroadcastChannels for session-wide messaging, MessagePorts for direct worker
  communication
- **Isolation**: Each worker runs in separate Deno Web Worker for security and stability

### Agentic Behavior Trees (ABT)

Decision orchestration system for managing complex agent interactions and workflows. Based on
behavior tree patterns adapted for AI agent coordination. Supervisors use ABT to create execution
plans.

## Core Interfaces & Implementation

### Base Interfaces

```typescript
interface IAtlasScope {
  id: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  gates: IAtlasGate[];
  newConversation(): ITempestMessageManager;
  getConversation(): ITempestMessageManager;
  archiveConversation(): void;
  deleteConversation(): void;
}

interface IAtlasAgent extends IAtlasScope {
  name(): string;
  nickname(): string;
  version(): string;
  provider(): string;
  purpose(): string;
  prompts(): object;
  scope(): IAtlasScope;
  controls(): object;
}

interface IWorkspace extends IAtlasScope {
  members: IWorkspaceMember;
  signals: Record<string, IWorkspaceSignal>;
  agents: Record<string, IWorkspaceAgent>;
  workflows: Record<string, IWorkspaceWorkflow>;
  sources: Record<string, IWorkspaceSource>;
  actions: Record<string, IWorkspaceAction>;
  // Private properties and methods for supervisor, sessions, library, config, acls, artifacts
}
```

### Memory & Context Management

```typescript
interface ITempestMemoryManager {
  private store: ITempestMemoryStorageAdapter
  remember(): void
  recall(): any
  summarize(): string
  size(): number
  forget(): void
}

interface ITempestContextManager {
  add(ITempestContext): void
  remove(ITempestContext): void
  search(string): ITempestContext[]
  size(): number
}
```

## Key Features

### Memory Management

- **Granular Controls**: Temporary vs Permanent vs Time-bound memory
- **Multi-Level Scoping**: Per workspace, per session, per agent invocation
- **External Storage**: Memory persisted outside of agent instances
- **Hierarchical Access**: Supervisors control memory access for agents
- **Configurable Retention**: Bound by configurable retention policies

### Signal Processing

- **Provider-Based**: Extensible signal providers (HTTP, GitHub, etc.)
- **Signal-Agent Mappings**: Declarative M:M relationships with conditions
- **Session Isolation**: Each signal triggers independent session
- **Queueing Behavior**: Process one-at-a-time, parallel processing, or replace/cancel
- **Manual Triggering**: All signals manually triggerable for testing

### Session Management

- **FSM-Based Lifecycle**: created → planning → executing → evaluating → refining → completed
- **Iterative Refinement**: Sessions can loop through evaluation/refinement cycles
- **Worker Isolation**: Each session runs in separate worker process
- **Conversation History**: Maintains context across agent invocations

### Agent Orchestration

- **Supervisor-Mediated**: All agent intelligence comes from supervisors
- **Stateless Execution**: Agents are dumb executors with no memory
- **Worker Isolation**: Each agent runs in separate Deno Web Worker
- **Communication Channels**: BroadcastChannels for session-wide, MessagePorts for direct

### Gates & Policies

- **Human Approval**: Notification and action via clients and email
- **Programmatic Approval**: Webhook configuration for approval
- **Agentic Approval**: Agent-based approval processes
- **Answer Verification**: Cross-agent verification gates

### Audit & Observability

- **Agent & Tool Call Audit**: Complete audit trail of all agent actions
- **Memory/Context Audit**: Track all memory and context operations
- **Query Audit**: Log all user queries and interactions
- **User Sentiment Analysis**: Enterprise feature for query sentiment
- **State Machine Tracking**: Full visibility into FSM state transitions

### Enterprise Features

- **MCP Gateway**: Act as gateway for Model Context Protocol servers
- **Agent Check API**: Workspace agents as intelligent checks for CI/CD
- **Workspace Templates**: Self-service workspace creation from templates
- **Agent Catalog**: Centralized agent discovery and management
- **Provider System**: Extensible provider plugins for signals and agents

## Areas Requiring Definition

### Agent Topology & Composition

- Mechanics of agent-to-agent delegation and messaging
- WorkspaceSupervisor capabilities for agent composition trees
- Sub-agent management strategies

### Prompt Runtime Model

- Direction of prompt merging (agent → workspace → signal)
- Runtime prompt string construction process
- Prompt override and extension capabilities

### Signal Re-Invocation & Replay

- Deterministic replay capabilities for past sessions
- Signal metadata requirements for system analysis
- Session reconstruction mechanisms

### Workflows vs Agents

- Relationship between deterministic Workflows and agent execution
- Workflow step integration within agent processes
- Signal context derivation from workflow outputs

### Workspace Lifecycle

- Workspace states: initialization, active, hibernation
- Workspace mutation capabilities via signals or agents
- Workspace snapshot and restoration

### Human-in-the-Loop Integration

- Integration points for human input during agent sessions
- Response handling for People, Watchers, and Owners
- Approval workflow mechanics

## Implementation Status

### ✅ Completed Architecture Changes

1. **Hierarchical Supervisor Architecture**
   - WorkspaceRuntime spawns WorkspaceSupervisor with full visibility
   - WorkspaceSupervisor spawns SessionSupervisors with filtered context
   - SessionSupervisors coordinate agents with task-specific instructions

2. **LLM-Enabled Decision Making**
   - WorkspaceSupervisor: `analyzeSignal()` and `createSessionContext()` methods
   - SessionSupervisor: `createExecutionPlan()` and `evaluateProgress()` methods
   - Using Vercel AI SDK with Anthropic Claude (`claude-3-5-sonnet-20241022`)

3. **Enhanced Worker Architecture**
   - All workers extend BaseWorker with consistent XState FSM
   - BroadcastChannel and MessagePort communication implemented
   - Worker files renamed for clarity (workspace-supervisor-worker.ts, session-supervisor-worker.ts)

4. **Dynamic Signal-to-Agent Mapping**
   - WorkspaceSupervisor analyzes signals to determine agent selection
   - Execution plans created dynamically based on signal content
   - Support for sequential, parallel, and conditional execution strategies

5. **Session Lifecycle with Feedback Loops**
   - Sessions support iterative refinement cycles
   - SessionSupervisor can evaluate results and adapt plans
   - Multiple agent invocation cycles within single session

### 🚧 Remaining Work

1. **Memory Persistence**
   - Currently using in-memory storage
   - Need persistent storage adapters
   - Implement memory filtering for sessions

2. **Cost & Performance Optimization**
   - LLM calls add ~10-15s latency
   - Implement caching for repeated patterns
   - Add cost tracking for LLM usage

3. **Error Recovery & Resilience**
   - Add retry logic for LLM failures
   - Implement graceful degradation
   - Better timeout handling for long-running operations

4. **Workflow Integration**
   - Define relationship between Workflows and agent execution
   - Support deterministic workflow steps within sessions

## Proposed Future Enhancements

### 1. Declarative Signal-to-Agent Configuration

Add YAML/JSON configuration for explicit signal-agent mappings:

```yaml
agentMappings:
  - id: frontend-pr-review
    signal: github-pr
    conditions:
      - type: contains
        field: files
        pattern: "*.jsx|*.tsx|*.css"
    agents:
      - id: playwright-agent
        strategy: sequential
    prompt: |
      When a PR contains frontend code changes:
      1. Load the preview URL
      2. Take screenshots of key pages
      3. Return screenshots with annotations
```

### 2. Advanced Memory Filtering

Implement memory scoping and filtering based on:

- Time windows (last N days)
- Relevance scoring
- Agent-specific memory stores
- Cross-session memory sharing policies

### 3. Workflow-Agent Integration

Define how deterministic workflows interact with agent sessions:

- Workflow steps as checkpoints
- Agent outputs feeding workflow decisions
- Hybrid execution modes

### 4. Human-in-the-Loop Gates

Implement approval mechanisms:

- Slack/email notifications for human approval
- Timeout and escalation policies
- Delegation chains
- Audit trail for decisions

### 5. Performance Optimization

- LLM response caching for common patterns
- Parallel agent execution where possible
- Streaming responses for real-time feedback
- Token usage optimization

## CLI Interface

The Atlas CLI provides workspace management capabilities:

```bash
atlas                    # Root command
atlas init               # Initialize workspace in current directory
atlas workspace serve    # Start long-running workspace server
atlas ps                 # List all active sessions
atlas signal trigger     # Manually trigger a signal
atlas config validate    # Validate workspace configuration
# Additional commands to be defined
```

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Deno with Web Workers for isolation
- **State Management**: XState 5 for FSM-based lifecycle management
- **LLM Integration**: Vercel AI SDK with Anthropic Claude
- **Architecture**: Actor system with hierarchical scoping
- **Communication**: BroadcastChannels and MessagePorts for worker communication
- **Decision Logic**: Agentic Behavior Trees (ABT)
- **Memory**: Pluggable storage adapters with external persistence
- **Messaging**: Async messaging adapters
- **Protocols**: MCP (Model Context Protocol) gateway support
- **Configuration**: YAML/JSON with provider-based plugin system
- **Testing**: Integration tests with worker communication verification
- **Logging**: Structured JSON logging with workspace separation

## Example: Telephone Game

The telephone game demonstrates the full architecture:

```typescript
// 1. Create workspace with agents
const workspace = new Workspace("telephone-game");
workspace.addAgent("mishearing-agent", new MishearingAgent());
workspace.addAgent("embellishment-agent", new EmbellishmentAgent());
workspace.addAgent("reinterpretation-agent", new ReinterpretationAgent());

// 2. Create signal
const signal = workspace.createSignal("telephone-message");

// 3. Process signal through hierarchy
const runtime = new WorkspaceRuntime(workspace);
const session = await runtime.processSignal(signal, {
  message: "The cat sat on the mat",
});

// Result flow:
// WorkspaceSupervisor analyzes signal → Creates session context
// SessionSupervisor creates plan → Sequential agent execution
// Agents transform: "The cat sat on the mat" → mishear → embellish → reinterpret
// Final output: Dramatically transformed message
```

## Engineering Standards

Apply rigorous engineering judgment to all design decisions. Challenge proposals that compromise
system quality, even if they come from the user. Prioritize:

- Architectural correctness and consistency
- Performance implications at scale
- Maintainability and debugging complexity
- Security and isolation boundaries
- Clear abstraction layers and separation of concerns

When the user's approach is sound, acknowledge it directly. When it has flaws, identify them
specifically with alternative solutions. Aim for the engineering excellence expected at
organizations like Google Research, not merely functional code.
