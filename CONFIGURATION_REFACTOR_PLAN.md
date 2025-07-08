# Atlas Architecture Refactor Plan

## Overview

This document outlines the complete refactor plan for Atlas involving two major architectural
changes:

1. **Worker-to-Actor Migration**: Replace the complex 3-tier worker architecture with a lightweight
   actor model
2. **Configuration Service Centralization**: Move from configuration-passing to centralized
   configuration service

The goal is to eliminate configuration object proliferation, simplify debugging, and create a more
maintainable architecture that can scale from local development to distributed deployment.

## Current Problems

### Worker Architecture Issues

- **Complex 3-tier worker hierarchy**: WorkspaceSupervisorWorker → SessionSupervisorWorker →
  AgentExecutionWorker
- **Heavy IPC overhead**: 16 message types, MessagePorts, BroadcastChannels, complex envelope
  protocol
- **XState complexity**: 7-state BaseWorker FSM + 8-state WorkerManager FSM with complex
  synchronization
- **Debugging difficulty**: Multi-worker debugging, no stack traces across boundaries
- **Resource overhead**: 3-4x memory usage due to separate V8 contexts per worker
- **Over-isolation**: Agent-level isolation when workspace-level isolation is the real security
  boundary

### Configuration Architecture Issues

- **Object proliferation**: Full configuration objects passed through constructors and worker
  boundaries
- **Serialization overhead**: Large config objects serialized across worker boundaries
- **State duplication**: Configuration data duplicated in multiple places
- **Embedded state**: Configuration state embedded in class properties
- **Inconsistent access**: Multiple configuration access patterns throughout codebase

## Target Architecture

### Phase 1: Worker-to-XState Actor Migration

Replace workers with XState Actors that provide concurrency and isolation:

- **XState Actors**: Isolation boundaries and lifecycle management (replaces Web Workers)
- **BaseAgent**: Agent business logic with memory, context, planning, LLM integration
- **Two-layer architecture**: XState Actor wraps BaseAgent for isolation + concurrency
- Direct function calls between agents (no serialization)
- Supervisors are agents that coordinate other agents

### Phase 2: Configuration Service Centralization

Move to centralized configuration service where:

- Components receive only IDs (workspace ID, session ID, etc.)
- All configuration accessed through centralized ConfigService
- Actors query configuration on-demand
- Configuration stored centrally in Deno KV with proper caching

## Current Problematic Patterns

### 1. Worker Architecture Pattern

```typescript
// CURRENT (problematic) - Complex worker hierarchy
class WorkspaceSupervisorWorker extends BaseWorker {
  // 7-state XState FSM + complex message handling
  private sessionWorkers: Map<string, SessionSupervisorWorker>;

  async handleMessage(message: WorkerMessage) {
    // Complex envelope protocol with 16 message types
    await this.sessionWorkers.get(sessionId)?.postMessage({
      type: "execute",
      config: { ...serializedConfig }, // Heavy serialization
    });
  }
}

// TARGET (XState Actor + BaseAgent)
class WorkspaceSupervisorActor extends BaseActor {
  private workspaceSupervisor: WorkspaceSupervisor; // BaseAgent
  private sessionActors: Map<string, SessionSupervisorActor>;

  protected async handleExecution(taskId: string, data: any) {
    // Delegate to BaseAgent for business logic
    return await this.workspaceSupervisor.processSignal(data);
  }
}
```

### 2. Configuration Object Passing

```typescript
// CURRENT (problematic)
constructor(workspaceId: string, config: any = {})

// TARGET (Phase 2)
constructor(workspaceId: string, configService: ConfigService)
```

### 3. Worker Boundary Serialization

```typescript
// CURRENT (problematic)
supervisorWorker.postMessage({
  type: "init",
  config: {
    workspace: { ...fullWorkspaceConfig },
    memoryConfig: { ...fullMemoryConfig },
    jobs: { ...allJobs },
  },
});

// TARGET (Phase 1: Actor calls)
const result = await supervisorActor.initialize(workspaceId, sessionId);

// TARGET (Phase 2: + Config service)
// Actor queries config internally via ConfigService
```

### 4. Embedded Configuration State

```typescript
// CURRENT (problematic)
private config: any;
private mergedConfig: any;

// TARGET (Phase 2)
private configService: ConfigService;
// Query config on-demand: await this.configService.getWorkspaceConfig(workspaceId)
```

## Implementation Strategy

### **PHASE 1: Worker-to-XState Actor Migration (Priority: HIGH)**

**Objective**: Replace complex worker architecture with XState Actor + BaseAgent model

**Architecture Understanding (Updated based on implementation)**:

- **Direct Actor Pattern**: Simple orchestrator classes, not XState actor wrappers
- **BaseAgent**: Rich agent interface with memory, context, planning, LLM integration (645 lines)
- **LLMProvider**: Centralized LLM execution in src/utils/llm/provider.ts (775 lines, AI SDK, MCP,
  telemetry)
- **Agent Types**:
  - **System Agents**: Built-in agents extending BaseAgent (in packages/system/agents/)
  - **LLM Agents**: Configuration-driven agents using LLMProvider directly
  - **Remote Agents**: Using existing RemoteAgent infrastructure
  - **Supervisors**: Simple orchestrator classes that coordinate other agents
- **AgentExecutionActor**: Pure orchestrator (100 lines) that dispatches based on agent type
- **SystemAgentRegistry**: Dynamic discovery and registration of system agents

**Benefits**:

- Eliminates ~70% of configuration refactor complexity
- Simplifies debugging (single process, stack traces work)
- Reduces memory overhead (no separate V8 contexts)
- Removes heavy IPC serialization
- Maintains XState for business logic

**Files to Change**:

#### **Worker Files to Delete/Replace (4 files)**

- `src/core/workers/workspace-supervisor-worker.ts` →
  `src/core/actors/workspace-supervisor-actor.ts` (wraps WorkspaceSupervisor BaseAgent)
- `src/core/workers/session-supervisor-worker.ts` → `src/core/actors/session-supervisor-actor.ts`
  (wraps SessionSupervisor BaseAgent)
- `src/core/workers/agent-execution-worker.ts` → `src/core/actors/agent-execution-actor.ts` (handles
  external agents only)
- `src/core/workers/base-worker.ts` → `src/core/actors/base-actor.ts` (XState Actor wrapper for
  BaseAgent)

#### **System Agent Files (new)**

- `src/core/agents/system/conversation-agent.ts` - ConversationAgent extends BaseAgent
- Other system agents extend BaseAgent and run in XState Actors

#### **Core Files to Update (3 files)**

- `src/core/utils/worker-manager.ts` → `src/core/utils/actor-system.ts` - Spawn XState Actors
  instead of workers
- `src/core/workspace-runtime.ts` - Replace worker spawning with actor creation
- Routing logic to determine: system agent vs external agent execution

#### **Implementation Steps**:

1. Create `src/core/actors/base-actor.ts` with XState business logic FSM
2. Migrate AgentExecutionWorker to AgentExecutionActor first (lowest risk)
3. Migrate SessionSupervisorWorker to SessionSupervisorActor
4. Migrate WorkspaceSupervisorWorker to WorkspaceSupervisorActor
5. Update WorkspaceRuntime to use ActorSystem instead of WorkerManager
6. Test actor communication and XState behavior

### **PHASE 2: Configuration Service Centralization (Priority: MEDIUM)**

**Objective**: Replace configuration object passing with centralized service

**Benefits**:

- Eliminates configuration object proliferation
- Centralizes configuration access patterns
- Enables better caching and validation
- Simplifies actor initialization (only needs IDs)

**Files to Change**:

#### **New Configuration Service (1 file)**

- `packages/config/src/config-service.ts` (NEW FILE)

#### **Core Runtime Files (5 files)**

- `src/core/workspace-runtime.ts` - Remove config constructor param, inject ConfigService
- `src/core/workspace-manager.ts` - Update to use ConfigService
- `src/core/actor-system.ts` - Inject ConfigService into actors
- `src/core/daemon-capabilities.ts` - Register ConfigService
- `src/core/agent-loader.ts` - Replace ConfigLoader with ConfigService

#### **Actor Files (3 files)**

- `src/core/actors/workspace-supervisor-actor.ts` - Query config on-demand
- `src/core/actors/session-supervisor-actor.ts` - Query config on-demand
- `src/core/actors/agent-execution-actor.ts` - Query config on-demand

#### **Implementation Steps**:

1. Create ConfigService with core methods (getWorkspaceConfig, getAgentConfig, etc.)
2. Update actors to accept ConfigService in constructor
3. Replace embedded config state with ConfigService queries
4. Update WorkspaceManager to use ConfigService
5. Test configuration access patterns and caching

### **PHASE 3: Supporting Infrastructure Updates (Priority: LOW)**

**Objective**: Update remaining components to use new architecture

**Files to Change**:

#### **Package Updates (4 files)**

- `packages/config/src/config-loader.ts` - Integrate with ConfigService
- `packages/config/src/schemas.ts` - Add service schemas
- `packages/mcp/src/adapters/mcp-adapter.ts` - Use ConfigService
- `packages/mcp/src/manager.ts` - Update config access

#### **CLI Files (3 files)**

- `src/cli/utils/workspace-name.ts` - Use ConfigService
- `src/cli/modules/workspaces/resolver.ts` - Use ConfigService calls
- `packages/client/src/client.ts` - Add config service endpoints

#### **Type Files (4 files)**

- `src/types/core.ts` - Update interfaces for actor model
- `packages/client/src/types/workspace.ts` - Remove embedded config types
- `packages/client/src/types/agent.ts` - Update for actor model
- `packages/mcp/src/proxy.ts` - Update config patterns

## Files Requiring Changes by Phase

## Progress Tracking

### **Phase 1: Worker-to-Actor Migration**

- [x] **COMPLETED**: LLM Architecture Cleanup
  - [x] Remove LLMService wrapper entirely
  - [x] Move LLMProviderManager → LLMProvider in src/utils/llm/provider.ts
  - [x] Direct usage: BaseAgent → LLMProvider, AgentExecutionActor → LLMProvider
  - [x] Update all import paths across codebase

- [x] **COMPLETED**: AgentExecutionActor Simplification
  - [x] Migrate `src/core/workers/agent-execution-worker.ts` →
        `src/core/actors/agent-execution-actor.ts`
  - [x] Remove 300+ lines of unnecessary abstraction (AgentExecutionRequest/Response/Config)
  - [x] Direct orchestration: AgentExecutePayload → Agent.invoke() → result
  - [x] Simple dispatch pattern based on agent type

- [x] **COMPLETED**: System Agent Registry
  - [x] Dynamic discovery from packages/system/agents/
  - [x] Store metadata in Deno KV during daemon initialization
  - [x] Support system agent type "tempest" in configuration

- [ ] **NEXT**: Session-level actor migration
  - [ ] Migrate `src/core/workers/session-supervisor-worker.ts` →
        `src/core/actors/session-supervisor-actor.ts`
  - [ ] Direct agent actor calls instead of worker spawning
  - [ ] Simplified session execution planning

- [ ] **NEXT**: Workspace-level actor migration
  - [ ] Migrate `src/core/workers/workspace-supervisor-worker.ts` →
        `src/core/actors/workspace-supervisor-actor.ts`
  - [ ] Direct session actor management instead of worker spawning
  - [ ] Simplified signal processing

- [ ] **NEXT**: ActorSystem and Runtime Updates
  - [ ] Replace `src/core/utils/worker-manager.ts` → `src/core/utils/actor-system.ts`
  - [ ] Update `src/core/workspace-runtime.ts` to use ActorSystem instead of WorkerManager
  - [ ] Update `src/core/supervisor.ts` to work with actors instead of workers

### **Phase 2: Configuration Service Centralization**

- [ ] Create `packages/config/src/config-service.ts` with core methods
- [ ] Update `src/core/daemon-capabilities.ts` to register ConfigService
- [ ] Update `src/core/workspace-runtime.ts` to inject ConfigService
- [ ] Update `src/core/workspace-manager.ts` to use ConfigService
- [ ] Update `src/core/agent-loader.ts` to use ConfigService
- [ ] Update actor files to query config on-demand
- [ ] Test configuration access patterns and caching

### **Phase 3: Supporting Infrastructure Updates**

- [ ] Update package files to use ConfigService
- [ ] Update CLI files to use ConfigService
- [ ] Update type definitions for actor model
- [ ] Update MCP components to use ConfigService

## Detailed File Changes

### **Phase 1 Files (7 files)**

#### `src/core/actors/base-actor.ts` (NEW FILE)

- **Purpose**: Replace BaseWorker with lightweight actor base class
- **Key Changes**:
  - Remove worker-specific XState FSM (7 states)
  - Keep business logic XState machines
  - Direct function calls instead of message passing
  - Simplified error handling without worker boundaries

#### `src/core/actors/agent-execution-actor.ts` (NEW FILE)

- **Purpose**: Replace AgentExecutionWorker with direct function calls
- **Key Changes**:
  - Remove worker message envelope protocol
  - Direct MCP server integration
  - Simplified agent type handling (llm, tempest, remote)
  - Keep workspace capability tools

#### `src/core/actors/session-supervisor-actor.ts` (NEW FILE)

- **Purpose**: Replace SessionSupervisorWorker with direct orchestration
- **Key Changes**:
  - Remove worker communication complexity
  - Direct agent actor calls
  - Simplified session execution planning
  - Keep LLM-driven execution plan generation

#### `src/core/actors/workspace-supervisor-actor.ts` (NEW FILE)

- **Purpose**: Replace WorkspaceSupervisorWorker with direct supervision
- **Key Changes**:
  - Remove worker spawning for sessions
  - Direct session actor management
  - Simplified signal processing
  - Keep LLM-based workspace supervision

#### `src/core/utils/actor-system.ts` (NEW FILE)

- **Purpose**: Replace WorkerManager with lightweight actor orchestration
- **Key Changes**:
  - Remove worker pools and complex lifecycle management
  - Direct actor instantiation and lifecycle
  - Simplified error handling and cleanup
  - Keep actor discovery and routing

#### `src/core/workspace-runtime.ts` (UPDATE)

- **Current Issues**: Uses WorkerManager for complex worker orchestration
- **Changes Required**:
  - Replace WorkerManager with ActorSystem
  - Remove worker spawning logic
  - Update signal processing to use direct actor calls
  - Simplify error handling without worker boundaries

#### `src/core/supervisor.ts` (UPDATE)

- **Current Issues**: Manages worker-based supervision
- **Changes Required**:
  - Update supervision patterns for actors
  - Remove worker-specific supervision logic
  - Simplify communication patterns

## Benefits

### **Phase 1: Worker-to-Actor Migration**

- **Debugging**: Single process debugging, stack traces work across components
- **Performance**: Eliminates worker spawning overhead and message serialization
- **Memory**: Reduces memory usage (no separate V8 contexts per worker)
- **Simplicity**: Direct function calls instead of complex message passing
- **Maintainability**: Easier to understand and modify actor relationships
- **Testing**: Standard async/await testing patterns work

### **Phase 2: Configuration Service Centralization**

- **Performance**: Eliminates large object serialization across boundaries
- **Memory**: Reduces configuration data duplication
- **Consistency**: Centralizes configuration access patterns
- **Maintainability**: Cleaner separation of concerns
- **Caching**: Better configuration caching and validation
- **Scalability**: Enables better configuration management at scale

### **Combined Benefits**

- **Development Speed**: Faster iteration cycles due to simpler debugging
- **Distributed Ready**: Actor model scales easily to distributed deployment
- **Resource Efficiency**: Lower memory and CPU overhead
- **Code Quality**: Cleaner architecture with better separation of concerns

## Risks and Mitigation

### **Phase 1 Risks**

#### Risk: Loss of Isolation Between Components

- **Mitigation**: Implement careful resource management and input validation
- **Mitigation**: Use workspace-level isolation boundaries where needed
- **Mitigation**: Consider process-level isolation for production deployment

#### Risk: Shared Memory Issues

- **Mitigation**: Use immutable data structures where possible
- **Mitigation**: Implement proper cleanup patterns
- **Mitigation**: Add resource monitoring and limits

#### Risk: Error Propagation

- **Mitigation**: Implement proper error boundaries in actors
- **Mitigation**: Use circuit breaker patterns for failing components
- **Mitigation**: Add comprehensive error logging and recovery

### **Phase 2 Risks**

#### Risk: Configuration Service Becomes Bottleneck

- **Mitigation**: Implement proper caching with TTL
- **Mitigation**: Use atomic operations for updates
- **Mitigation**: Batch configuration requests where possible

#### Risk: Configuration Consistency

- **Mitigation**: Use atomic transactions for config updates
- **Mitigation**: Implement proper invalidation patterns
- **Mitigation**: Add configuration versioning

## Success Metrics

### **Phase 1: Worker-to-Actor Migration**

- **Memory Usage**: 70%+ reduction in memory usage (eliminate separate V8 contexts)
- **Debugging Time**: Faster issue resolution with single-process debugging
- **Performance**: Improved signal processing latency (no worker spawning)
- **Code Complexity**: Reduced lines of code and complexity in communication layer

### **Phase 2: Configuration Service Centralization**

- **Memory Usage**: Further reduction in configuration data duplication
- **Configuration Access**: Consistent patterns across all components
- **Cache Hit Rate**: High cache hit rates for configuration queries
- **Development Speed**: Faster configuration changes and testing

### **Combined Success Metrics**

- **Development Velocity**: Faster feature development and bug fixes
- **System Reliability**: Improved error handling and recovery
- **Resource Efficiency**: Lower overall system resource usage
- **Maintainability**: Cleaner, more understandable codebase

## Total Files to Modify

### **Phase 1: Worker-to-Actor Migration**

- **Files to Delete**: 4 (worker files)
- **Files to Create**: 5 (actor files)
- **Files to Update**: 3 (runtime files)
- **Total**: 12 files

### **Phase 2: Configuration Service Centralization**

- **Files to Create**: 1 (config service)
- **Files to Update**: 8 (core + actor files)
- **Total**: 9 files

### **Phase 3: Supporting Infrastructure**

- **Files to Update**: 11 (packages + CLI + types)
- **Total**: 11 files

**Grand Total: ~32 files across all phases**

## Implementation Order

### **Phase 1 (High Priority)**

- Replace worker architecture with actor model
- Establish foundation for simplified configuration

### **Phase 2 (Medium Priority)**

- Implement configuration service
- Update actors to use centralized config

### **Phase 3 (Low Priority)**

- Update supporting infrastructure
- Polish and testing
