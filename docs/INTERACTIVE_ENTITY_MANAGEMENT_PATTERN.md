# Interactive Entity Management Pattern

## Overview

This document defines a generalized interaction pattern for managing Atlas entities (signals,
agents, sessions, jobs, libraries) through a consistent, progressive selection interface. The
pattern emerged from the signal management implementation and provides a blueprint for all Atlas
entity interactions.

## Core Pattern Architecture

### Universal Flow Structure

```
/{entity} → [Workspace Selection] → [Entity Selection] → [Action Selection] → [Execute Action]
```

This pattern provides consistent user experience across all Atlas entities while allowing
entity-specific customizations.

## Generalized Components

### 1. Entity Selection Component Template

```typescript
interface EntitySelectionProps<T> {
  workspaceId: string;
  onEscape: () => void;
  onEntitySelect: (entityId: string) => void;
}

interface EntityEntry {
  id: string;
  name: string;
  description?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export const EntitySelection = <T extends EntityEntry>({
  workspaceId,
  onEscape,
  onEntitySelect,
  entityType, // "signals" | "agents" | "sessions" | "jobs" | "libraries"
  fetchFunction, // Abstracted fetch function
}: EntitySelectionProps<T>) => {
  // Universal loading, error, and selection logic
  // Entity-specific fetching via passed function
  // Consistent UI patterns with entity-appropriate labeling
};
```

### 2. Entity Action Selection Template

```typescript
interface ActionDefinition {
  value: string;
  label: string;
  description: string;
  requiresInput?: boolean;
  inputType?: "text" | "json" | "file" | "select";
  inputOptions?: string[];
}

const ENTITY_ACTIONS: Record<string, ActionDefinition[]> = {
  signals: [
    { value: "describe", label: "Describe", description: "Show signal details and documentation" },
    {
      value: "trigger",
      label: "Trigger",
      description: "Send signal with custom input",
      requiresInput: true,
      inputType: "json",
    },
  ],
  agents: [
    {
      value: "describe",
      label: "Describe",
      description: "Show agent configuration and capabilities",
    },
    { value: "status", label: "Status", description: "Check agent health and availability" },
    { value: "test", label: "Test", description: "Run agent connectivity test" },
    {
      value: "invoke",
      label: "Invoke",
      description: "Send message to agent",
      requiresInput: true,
      inputType: "text",
    },
  ],
  sessions: [
    { value: "describe", label: "Describe", description: "Show session details and metadata" },
    { value: "logs", label: "Logs", description: "View session execution logs" },
    { value: "status", label: "Status", description: "Check session current state" },
    { value: "kill", label: "Kill", description: "Terminate running session" },
  ],
  jobs: [
    {
      value: "describe",
      label: "Describe",
      description: "Show job configuration and requirements",
    },
    {
      value: "execute",
      label: "Execute",
      description: "Run job with parameters",
      requiresInput: true,
      inputType: "json",
    },
    {
      value: "schedule",
      label: "Schedule",
      description: "Schedule job for future execution",
      requiresInput: true,
      inputType: "text",
    },
    { value: "history", label: "History", description: "View job execution history" },
  ],
  libraries: [
    { value: "describe", label: "Describe", description: "Show library metadata and contents" },
    { value: "browse", label: "Browse", description: "Explore library items and structure" },
    {
      value: "search",
      label: "Search",
      description: "Search library contents",
      requiresInput: true,
      inputType: "text",
    },
    {
      value: "add",
      label: "Add Item",
      description: "Add new item to library",
      requiresInput: true,
      inputType: "json",
    },
  ],
};
```

### 3. Entity Details Component Template

```typescript
interface EntityDetailsProps {
  workspaceId: string;
  entityId: string;
  entityType: string;
}

export const EntityDetails = ({ workspaceId, entityId, entityType }: EntityDetailsProps) => {
  // Universal loading and error handling
  // Entity-specific data fetching via registry pattern
  // Dynamic detail rendering based on entity schema
  // Consistent formatting and styling
};
```

### 4. Entity Input Component Template

```typescript
interface EntityInputProps {
  entityId: string;
  entityType: string;
  action: string;
  inputType: "text" | "json" | "file" | "select";
  inputOptions?: string[];
  onEscape: () => void;
  onSubmit: (input: string) => void;
}

export const EntityInput = ({
  entityId,
  entityType,
  action,
  inputType,
  inputOptions,
  onEscape,
  onSubmit,
}: EntityInputProps) => {
  // Input type-specific rendering
  // Validation based on inputType
  // Consistent styling and behavior
};
```

## Entity Registry Pattern

### 1. Entity Configuration Registry

```typescript
interface EntityConfig {
  displayName: string;
  pluralName: string;
  fetchFunction: (workspaceId: string) => Promise<EntityEntry[]>;
  detailsComponent: React.ComponentType<EntityDetailsProps>;
  actions: ActionDefinition[];
  triggerFunction?: (
    workspaceId: string,
    entityId: string,
    action: string,
    input?: string,
  ) => Promise<ActionResult>;
}

const ENTITY_REGISTRY: Record<string, EntityConfig> = {
  signals: {
    displayName: "Signal",
    pluralName: "Signals",
    fetchFunction: fetchSignals,
    detailsComponent: SignalDetails,
    actions: ENTITY_ACTIONS.signals,
    triggerFunction: executeSignalAction,
  },
  agents: {
    displayName: "Agent",
    pluralName: "Agents",
    fetchFunction: fetchAgents,
    detailsComponent: AgentDetails,
    actions: ENTITY_ACTIONS.agents,
    triggerFunction: executeAgentAction,
  },
  sessions: {
    displayName: "Session",
    pluralName: "Sessions",
    fetchFunction: fetchSessions,
    detailsComponent: SessionDetails,
    actions: ENTITY_ACTIONS.sessions,
    triggerFunction: executeSessionAction,
  },
  jobs: {
    displayName: "Job",
    pluralName: "Jobs",
    fetchFunction: fetchJobs,
    detailsComponent: JobDetails,
    actions: ENTITY_ACTIONS.jobs,
    triggerFunction: executeJobAction,
  },
  libraries: {
    displayName: "Library",
    pluralName: "Libraries",
    fetchFunction: fetchLibraries,
    detailsComponent: LibraryDetails,
    actions: ENTITY_ACTIONS.libraries,
    triggerFunction: executeLibraryAction,
  },
};
```

### 2. Universal Fetch Functions

```typescript
// Standardized fetch function signatures
export async function fetchSignals(workspaceId: string): Promise<EntityEntry[]> {
  const client = getDaemonClient();
  const workspace = await client.getWorkspace(workspaceId);
  const config = await loadWorkspaceConfigNoCwd(workspace.path);
  return Object.entries(config.signals || {}).map(([id, signal]) => ({
    id,
    name: id,
    description: signal?.description,
    status: "configured",
    metadata: signal,
  }));
}

export async function fetchAgents(workspaceId: string): Promise<EntityEntry[]> {
  const client = getDaemonClient();
  const workspace = await client.getWorkspace(workspaceId);
  const config = await loadWorkspaceConfigNoCwd(workspace.path);
  const agents = processAgentsFromConfig(config);
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name || agent.id,
    description: agent.purpose,
    status: agent.status || "unknown",
    metadata: { type: agent.type, ...agent },
  }));
}

export async function fetchSessions(workspaceId: string): Promise<EntityEntry[]> {
  const client = getDaemonClient();
  const workspace = await client.getWorkspace(workspaceId);
  const result = await fetchSessionsAPI({ workspace: workspace.name, port: 8080 });
  if (!result.success) throw new Error(result.error);
  return result.filteredSessions.map((session) => ({
    id: session.id,
    name: session.name || session.id,
    description: session.description,
    status: session.status,
    metadata: session,
  }));
}

// Similar patterns for jobs and libraries...
```

## Interactive Command Integration

### 1. Unified Command Handler

```typescript
export default function InteractiveCommand() {
  // Universal state management
  const [currentEntity, setCurrentEntity] = useState<string | null>(null);
  const [currentEntityId, setCurrentEntityId] = useState<string | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<string | null>(null);
  const [showEntitySelection, setShowEntitySelection] = useState(false);
  const [showActionSelection, setShowActionSelection] = useState(false);
  const [showEntityInput, setShowEntityInput] = useState(false);
  const [currentAction, setCurrentAction] = useState<ActionDefinition | null>(null);

  // Universal handlers
  const handleEntityCommand = (entityType: string) => {
    setCurrentEntity(entityType);
    setWorkspaceSelectionContext(`${entityType}-select`);
    setShowWorkspaceSelection(true);
  };

  const handleEntitySelect = (entityId: string) => {
    setCurrentEntityId(entityId);
    setShowEntitySelection(false);
    setShowActionSelection(true);
  };

  const handleActionSelect = (action: string) => {
    const actionDef = ENTITY_REGISTRY[currentEntity!].actions.find((a) => a.value === action);
    setCurrentAction(actionDef!);
    setShowActionSelection(false);

    if (actionDef!.requiresInput) {
      setShowEntityInput(true);
    } else {
      executeAction(action);
    }
  };

  // Command routing
  const handleCommand = (input: string) => {
    const parsed = parseSlashCommand(input);
    if (ENTITY_REGISTRY[parsed.command]) {
      handleEntityCommand(parsed.command);
    }
    // ... other command handling
  };
}
```

### 2. Dynamic Component Rendering

```typescript
// Universal rendering pattern
{
  showEntitySelection && currentEntity && currentWorkspace
    ? (
      <EntitySelection
        workspaceId={currentWorkspace}
        entityType={currentEntity}
        fetchFunction={ENTITY_REGISTRY[currentEntity].fetchFunction}
        onEscape={() => {
          setShowEntitySelection(false);
          setCurrentEntity(null);
          setCurrentWorkspace(null);
        }}
        onEntitySelect={handleEntitySelect}
      />
    )
    : showActionSelection && currentEntity && currentEntityId
    ? (
      <EntityActionSelection
        entityType={currentEntity}
        entityId={currentEntityId}
        actions={ENTITY_REGISTRY[currentEntity].actions}
        onEscape={() => {
          setShowActionSelection(false);
          setCurrentEntityId(null);
        }}
        onActionSelect={handleActionSelect}
      />
    )
    : showEntityInput && currentEntity && currentEntityId && currentAction
    ? (
      <EntityInput
        entityId={currentEntityId}
        entityType={currentEntity}
        action={currentAction.value}
        inputType={currentAction.inputType || "text"}
        inputOptions={currentAction.inputOptions}
        onEscape={() => {
          setShowEntityInput(false);
          setCurrentAction(null);
        }}
        onSubmit={handleEntityActionSubmit}
      />
    )
    : (
      // Default command input
      <CommandInput onSubmit={handleCommand} />
    );
}
```

## Abstracted Action Execution

### 1. Universal Action Interface

```typescript
interface ActionResult {
  success: boolean;
  data?: any;
  error?: string;
  sessionId?: string;
  duration: number;
  metadata?: Record<string, unknown>;
}

interface ActionExecutor {
  execute(
    workspaceId: string,
    entityId: string,
    action: string,
    input?: string,
  ): Promise<ActionResult>;
}
```

### 2. Entity-Specific Action Modules

```typescript
// src/cli/modules/signals/actions.ts
export const signalActionExecutor: ActionExecutor = {
  async execute(workspaceId, signalId, action, input) {
    switch (action) {
      case "describe":
        return { success: true, data: await getSignalDetails(workspaceId, signalId), duration: 0 };
      case "trigger":
        return await triggerSignalSimple(workspaceId, signalId, input);
      default:
        throw new Error(`Unknown signal action: ${action}`);
    }
  },
};

// src/cli/modules/agents/actions.ts
export const agentActionExecutor: ActionExecutor = {
  async execute(workspaceId, agentId, action, input) {
    switch (action) {
      case "describe":
        return { success: true, data: await getAgentDetails(workspaceId, agentId), duration: 0 };
      case "status":
        return await checkAgentStatus(workspaceId, agentId);
      case "test":
        return await testAgentConnectivity(workspaceId, agentId);
      case "invoke":
        return await invokeAgent(workspaceId, agentId, input);
      default:
        throw new Error(`Unknown agent action: ${action}`);
    }
  },
};

// Similar patterns for sessions, jobs, libraries...
```

## Benefits of This Pattern

### 1. Consistency Across Entities

- **Predictable UX**: Same flow pattern for all entity types
- **Reduced Learning Curve**: Users learn once, apply everywhere
- **Consistent Styling**: Unified visual language across all entities

### 2. Maintainable Architecture

- **DRY Compliance**: Shared components and logic across entities
- **Single Source of Truth**: Entity configurations in registry
- **Testable Components**: Business logic separated from UI

### 3. Extensible Design

- **Easy Entity Addition**: Add new entities via registry pattern
- **Action Extensibility**: Add new actions per entity type
- **Component Reusability**: Generic components work for all entities

### 4. Type Safety

- **Full TypeScript**: Interfaces for all patterns and components
- **Compile-Time Validation**: Entity registry enforces consistency
- **Runtime Safety**: Validation at interaction boundaries

## Implementation Roadmap

### Phase 1: Refactor Existing Signal Implementation

1. Extract signal-specific code into registry pattern
2. Create generic EntitySelection component from SignalSelection
3. Generalize action selection and input components

### Phase 2: Implement Agent Management

1. Create agent action executor with describe/status/test/invoke
2. Implement AgentDetails component with agent-specific information
3. Integrate agent management into interactive command flow

### Phase 3: Implement Session Management

1. Create session action executor with describe/logs/status/kill
2. Implement SessionDetails component with session metadata
3. Add session log viewing capabilities

### Phase 4: Implement Job and Library Management

1. Create job action executor with describe/execute/schedule/history
2. Create library action executor with describe/browse/search/add
3. Implement corresponding detail components

### Phase 5: Advanced Features

1. Cross-entity relationships and navigation
2. Batch operations across multiple entities
3. Entity analytics and recommendations
4. Custom action plugins and extensions

This pattern establishes a foundation for comprehensive Atlas entity management while maintaining
consistency, extensibility, and type safety across the entire CLI interface.
