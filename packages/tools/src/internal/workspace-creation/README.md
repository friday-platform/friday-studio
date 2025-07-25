# Atlas Workspace Creation Architecture

**Purpose**: Enable natural language workspace creation through intelligent AI orchestration
**Approach**: Single tool with hidden complexity, maximum reliability, zero schema duplication

## Design Intent

### Relationship to Conversation Agent Architecture

This workspace creation system implements one domain of the conversation agent's resource-driven knowledge architecture (see `@specs/conversation-agent.md`). The conversation agent maintains a minimal core prompt focused on natural interaction, while delegating specialized technical knowledge to domain-specific systems like this one.

The separation of concerns exists for architectural reasons:

- **Intent Recognition**: The conversation agent handles natural language understanding and user goal interpretation
- **Context Translation**: The bridge layer converts conversational context into structured requirements
- **Technical Execution**: The workspace creation system contains Atlas-specific knowledge about schemas, components, and configuration patterns

This separation allows the conversation agent to maintain its task-focused, natural language interface while accessing deep technical expertise when needed. The conversation agent calls `atlas_create_workspace` when it recognizes workspace creation intent, providing user context without needing to understand Atlas configuration details.

### Core Problem Addressed

Atlas workspaces require understanding of component relationships, YAML syntax, and schema validation. Users need to know how signals connect to jobs, how agents are configured, and what constitutes valid configuration structure.

The workspace creation system handles this technical complexity internally, accepting natural language descriptions and producing valid configurations. This enables the conversation agent to maintain its principle of "tasks over architecture" - users describe what they want to accomplish, not how Atlas should implement it.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                 atlas_create_workspace                      │
│  Single Tool Interface                                      │
│  • userIntent: "Monitor Nike for new shoes"                 │
│  • conversationContext: Optional dialogue context           │
│  • requirements: Structured constraints                     │
│  • debugLevel: "minimal" (default) | "detailed"             │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│              WorkspaceGenerator                             │
│  Generate-Validate-Repair Loop                              │
│  ┌─────────────────┐ ┌────────────────────────────────────┐ │
│  │     Generate    │ │           Validate                 │ │
│  │  Claude Sonnet 4│ │    @atlas/config schemas           │ │
│  │  Tool Assembly  │ │    Reference integrity             │ │
│  │  Max 40 steps   │ │    Semantic validation             │ │
│  └─────────────────┘ └────────────────────────────────────┘ │
│  ┌──────────────────┐           Attempt History             │
│  │     Repair       │           Error Context               │
│  │  Progressive     │           Temperature Reduction       │
│  │  Temperature     │           Max 3 Attempts              │
│  │  0.4 → 0.3 → 0.2 │                                       │
│  └──────────────────┘                                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│              WorkspaceBuilder                               │
│  Stateful Configuration Assembly                            │
│  • Maps for clean state management                          │
│  • Direct @atlas/config schema imports                      │
│  • Real-time validation and error reporting                 │
│  • Reference integrity checking                             │
│  • Export to final WorkspaceConfig format                   │
└─────────────────────────────────────────────────────────────┘
```

## Design Principles

### 1. Single Source of Truth

**Principle**: All schemas and validation logic live in `@atlas/config` - zero duplication.

**Implementation**: Tools import schemas directly and use TypeScript types to ensure compatibility. When config schemas evolve, workspace generation automatically gets the updates.

**Benefit**: Eliminates schema drift, reduces maintenance overhead, ensures consistency across the entire Atlas ecosystem.

### 2. Hidden Complexity, Clean Results

**Principle**: Users see successful workspace creation, not retry mechanics or internal failures.

**Implementation**: The Generate-Validate-Repair loop handles up to 3 attempts internally, with progressive temperature reduction and error context accumulation. Only final success or complete failure surfaces to users.

**Benefit**: Separates user interface from internal retry complexity while preserving error handling.

### 3. Schema Reuse Over Recreation

**Principle**: Leverage existing comprehensive schemas rather than rebuilding simplified versions.

**Implementation**:

```typescript
// Direct schema import - no duplication
import { WorkspaceSignalConfigSchema } from "@atlas/config";

// Tool uses exact schema with constraints
parameters: WorkspaceSignalConfigSchema.extend({
  provider: z.literal("schedule"), // Constrain to specific type
});
```

**Benefit**: Automatic consistency, reduced code, immediate access to schema enhancements.

### 4. Progressive Intelligence

**Principle**: Each repair attempt gets smarter by learning from previous failures.

**Implementation**: Attempt history provides error context to subsequent generations. Temperature reduction (0.4 → 0.3 → 0.2) increases determinism for convergence. System prompt includes repair guidance and common error patterns.

**Benefit**: Enables recovery from validation failures through error context accumulation.

### 5. Tool-Based Assembly

**Principle**: LLM builds workspaces through structured tool calls, not direct JSON generation.

**Implementation**: Specialized tools handle different aspects:

- `initializeWorkspace`: Identity and metadata
- `addScheduleSignal`: Cron-based triggers
- `addLLMAgent`: AI processing capabilities
- `createJob`: Signal-to-agent execution pipelines
- `validateWorkspace`: Final configuration verification

**Benefit**: Structured thinking, better error localization, educational transparency through visible tool usage.

## Key Components

### WorkspaceBuilder

**Purpose**: Manages workspace construction state with validation at every step.

**Key Features**:

- Map-based state management (signals, agents, jobs, MCP servers)
- Real-time validation using authoritative config schemas
- Reference integrity checking (no broken agent/signal/job links)
- Clean export to final WorkspaceConfig format

**Design Philosophy**: Never allow invalid state to persist. Validate immediately, fail fast, provide clear error context.

### WorkspaceGenerator

**Purpose**: Orchestrates the multi-attempt generation process with intelligent repair.

**Key Features**:

- Generate-Validate-Repair loop with attempt history
- Progressive temperature reduction for convergence
- Context-aware prompt building with user requirements
- Clean separation of attempt complexity from user results

**Design Philosophy**: Hide retry complexity but maintain detailed error context for debugging and improvement.

### Workspace Building Tools

**Purpose**: Provide structured interface for LLM to assemble workspace components.

**Key Features**:

- Direct type compatibility with `@atlas/config` schemas
- Zod v4 schemas with rich `.meta()` descriptions for better LLM usage
- Immediate validation feedback with descriptive error messages
- Integration with singleton WorkspaceBuilder instance

**Design Philosophy**: Tools should feel natural to the LLM while enforcing strict validation and maintaining type safety.

## How It Works

### 1. Intent Processing

User provides natural language description of their automation needs. The conversation agent calls `atlas_create_workspace` with structured context about triggers, integrations, and outputs.

### 2. Generation Phase

Claude Sonnet 4 analyzes the user intent and builds a workspace configuration by calling workspace building tools in logical sequence:

1. Initialize workspace identity
2. Add trigger signals (schedule, webhook, system)
3. Add processing agents (LLM, remote, system)
4. Create execution jobs connecting signals to agents
5. Add MCP integrations for external services
6. Validate complete configuration

### 3. Validation Phase

Each tool call validates immediately using authoritative `@atlas/config` schemas. The final `validateWorkspace` call ensures:

- Complete schema compliance with WorkspaceConfigSchema
- No broken references between components
- Semantic correctness of configuration relationships

### 4. Repair Phase (if needed)

If validation fails, the system captures error details and attempts regeneration with:

- Previous attempt context for learning
- Reduced temperature for more deterministic output
- Enhanced system prompt with common error patterns
- Maximum 3 attempts before declaring failure

### 5. Result Export

Successful generation returns a complete WorkspaceConfig that can be immediately written to the filesystem and loaded by Atlas runtime.

## Implementation Characteristics

### User Interface

- Accepts natural language descriptions instead of YAML configuration
- Handles multiple generation attempts internally
- Returns final success or failure state
- Abstracts Atlas component relationships from user input

### Development Properties

- Schema changes propagate automatically through direct imports
- Tool usage visible through rich event streaming
- Error context preserved for debugging
- Component relationships validated at assembly time

### System Integration

- Eliminates duplicate schema definitions through reuse
- TypeScript enforces tool/config compatibility
- Uses existing tool patterns for extensibility
- Applies consistent validation across interfaces

## Design Targets

- Schema compliance with production `@atlas/config` validation
- Reference integrity between workspace components
- Generation attempts complete within reasonable time bounds
- Conversation agent workflow integration
- Reduced code duplication through schema reuse

## Future Enhancements

### Progressive Learning

- Pattern recognition for common automation types
- User preference learning for technical detail levels
- Template generation from successful configurations

### Advanced Capabilities

- Incremental workspace modification after creation
- Multi-workspace coordination and dependencies
- Performance optimization through configuration caching

### Enhanced Intelligence

- Failure pattern analysis for prompt improvement
- User feedback integration for repair strategy enhancement
- Domain-specific optimization for different automation categories

---

This architecture implements one component of the conversation agent's resource-driven knowledge system. It handles workspace creation complexity internally while integrating with the conversation agent's natural language interface and structured event streaming patterns.
