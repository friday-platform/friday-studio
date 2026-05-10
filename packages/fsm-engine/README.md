# FSM Engine

Direct finite state machine execution engine for Atlas. Defines workflows as
states, transitions, and actions. States store documents; transitions execute
LLM calls, invoke agents, send notifications, or emit events.

## Features

- Load FSM definitions from YAML or build programmatically
- Execute state transitions driven by signals
- Store typed documents in states with JSON Schema validation
- Execute actions: LLM calls, agent invocations, notifications, event emission
- Test transitions with before/after validation
- Serialize/restore FSMs from persistent storage
- MCP tools for FSM creation and testing

## Architecture

FSM workflows are defined in YAML. Queue-based signal processing with recursion
protection. Documents persist across transitions using `@atlas/document-store`.

### Components

- **FSMEngine**: Main executor - loads FSM definitions, processes signals,
  executes actions, manages documents
- **Serializer**: YAML ↔ FSM structure conversion with Zod validation
- **TestRunner**: Executes transition tests with state/document assertions
- **Validator**: Comprehensive structural validation with detailed error
  messages

## Core Concepts

### States

States contain:

- **documents**: JSON objects with type and data (validated against JSON Schema)
- **entry**: Actions executed when entering state
- **on**: Map of event → transition(s)
- **type**: Optional "final" for terminal states

Documents persist across state transitions unless explicitly removed.

### Transitions

Triggered by signals. Each transition has:

- **target**: Destination state
- **actions**: Executed sequentially - LLM calls, agent invocations,
  notifications, event emission

Multiple transitions can handle the same event; the first matching transition
wins.

### Signals

External inputs triggering transitions:

```typescript
{ type: "APPROVE", data: { approvedBy: "user-123" } }
```

Signals queue if FSM is processing. Executed in order.

### Actions

**LLM Actions**: Call language model with context and tools

```yaml
type: llm
provider: anthropic
model: claude-sonnet-4-6
prompt: "Generate shipping label for this order"
tools: ["get_address", "calculate_shipping"] # Tools LLM can call
outputTo: shipping-label # Document ID to store result
```

**Agent Actions**: Invoke Atlas agents

```yaml
type: agent
agentId: weather-fetcher
outputTo: weather-data
```

**Notification Actions**: Broadcast to chat communicators

```yaml
type: notification
message: "Order processed"
communicators: ["slack"] # Optional allowlist; omit to broadcast to all
```

**Emit Actions**: Send events to external systems

```yaml
type: emit
event: order.approved
data: { orderId: "{{order.id}}" }
```

## Usage

### Define FSM in YAML

```yaml
fsm:
  id: order-processor
  initial: pending

  documentTypes:
    Order:
      type: object
      properties:
        items: { type: array }
        total: { type: number }
        status: { type: string }
      required: [items, total]

  states:
    pending:
      documents:
        - id: order-001
          type: Order
          data: { items: ["laptop"], total: 1200, status: "pending" }

      on:
        APPROVE:
          target: approved
          actions:
            - type: llm
              provider: anthropic
              model: claude-sonnet-4-6
              prompt: "Validate this order and mark its status."
              outputTo: order-001
              outputType: Order
            - type: emit
              event: order.approved

    approved:
      type: final
```

### Execute FSM

```typescript
import { loadFromFile } from "@atlas/fsm-engine";
import { FileSystemDocumentStore } from "@atlas/document-store";

const store = new FileSystemDocumentStore({ basePath: "./data" });
const scope = { workspaceId: "ws-1", sessionId: "session-1" };

const engine = await loadFromFile("./order-processor.yaml", {
  documentStore: store,
  scope,
});

await engine.initialize();

// Send signal
await engine.signal({ type: "APPROVE", data: { approvedBy: "admin" } });

// Check result
console.log(engine.getState()); // "approved"
console.log(engine.getDocuments()); // [{ id: "order-001", ... }]
```

### Build Programmatically

Construct an `FSMDefinition` object directly (the same shape the YAML
loader produces) and hand it to `FSMEngine`:

```typescript
import { type FSMDefinition, FSMEngine } from "@atlas/fsm-engine";

const fsm: FSMDefinition = {
  id: "order-processor",
  initial: "pending",
  documentTypes: {
    Order: {
      type: "object",
      properties: {
        items: { type: "array" },
        total: { type: "number" },
        status: { type: "string" },
      },
      required: ["items", "total"],
    },
  },
  states: {
    pending: {
      documents: [{
        id: "order",
        type: "Order",
        data: { items: ["laptop"], total: 1200, status: "pending" },
      }],
      on: {
        APPROVE: {
          target: "approved",
          actions: [
            {
              type: "llm",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              prompt: "Validate this order and mark its status.",
              outputTo: "order",
              outputType: "Order",
            },
            { type: "emit", event: "order.approved", data: { orderId: "order" } },
          ],
        },
      },
    },
    approved: { type: "final" },
  },
};

const engine = new FSMEngine(fsm, { documentStore, scope });
await engine.initialize();
```

## Testing

### Define Test

```typescript
import { TestRunner } from "@atlas/fsm-engine";

const test = {
  name: "Approve order with inventory",
  fsm: orderProcessorFSM,
  setup: {
    state: "pending",
    documents: [
      {
        id: "order",
        type: "Order",
        data: { items: ["laptop"], total: 1200, status: "pending" },
      },
    ],
  },
  signal: { type: "APPROVE" },
  assertions: {
    state: "approved",
    documents: [
      { id: "order", data: { status: "validated" } }, // Partial match
    ],
    emittedEvents: [
      { event: "order.approved" },
    ],
  },
};

import { InMemoryDocumentStore } from "@atlas/document-store";

const runner = new TestRunner(new InMemoryDocumentStore(), {
  workspaceId: "test",
  sessionId: "test-session",
});
const result = await runner.runTest(test);

console.log(result.passed); // true/false
console.log(result.errors); // Array of error messages
```

Document assertions use partial matching - only specified fields are checked.
See [TESTING.md](./TESTING.md) for details.

## Document Validation

Documents are validated against JSON Schema definitions:

```yaml
documentTypes:
  Order:
    type: object
    properties:
      items:
        type: array
        items: { type: string }
      total:
        type: number
        minimum: 0
      status:
        type: string
        enum: [pending, approved, rejected]
    required: [items, total, status]
```

Validation occurs:

- On initialization (loading from definition or storage)
- On document update (via `updateDoc()`)
- On document creation (via `createDoc()`)

Failed validation throws error with field-level details.

## LLM Integration

FSM actions can call LLMs with document context and tools:

```yaml
actions:
  - type: llm
    provider: anthropic
    model: claude-sonnet-4-6
    prompt: |
      Review this order for fraud and get customer history.
      Use the get_customer_history tool to check past orders.
    tools: ["get_customer_history"]
    outputTo: fraud-check
```

Documents are automatically injected into prompt. LLM can call tools defined in
the FSM. Response stored in specified document.

### Tool Allowlist

The `tools:` array on an LLM action is a string allowlist of tool names —
referencing MCP server tools or platform tools registered with the engine
(e.g. `delegate`, `request_tool_access`, `get_<server>_<name>`). Tool
implementations live outside the FSM definition; the engine resolves them at
action execution time and narrows the LLM's tool surface to the listed names.

When `tools:` is omitted, the action gets the safe-by-default platform tool
surface; an empty array opts out of every workspace-defined tool.

Configure LLM provider:

```typescript
import { AtlasLLMProviderAdapter } from "@atlas/fsm-engine";

const llmProvider = new AtlasLLMProviderAdapter(
  platformModels.get("conversational"),
  { maxSteps: 10 },
);

const engine = new FSMEngine(fsm, {
  documentStore,
  scope,
  llmProvider,
});
```

## MCP Tools

FSM engine exposes MCP tools for LLM agents:

### `fsm_create`

Create and validate an FSM definition. Accepts the full structure: states,
transitions, actions (`llm` / `agent` / `notification` / `emit`), and
optional `documentTypes`.

```json
{
  "tool": "fsm_create",
  "arguments": {
    "definition": {
      "id": "order-processor",
      "initial": "pending",
      "documentTypes": { "Order": {...} },
      "states": { "pending": {...}, "approved": { "type": "final" } }
    }
  }
}
```

### `fsm_validate`

Validate FSM structure against constraints. Returns detailed errors.

### `fsm_to_yaml`

Convert FSM to YAML format for storage.

### `fsm_test_create`, `fsm_test_run`, `fsm_test_suite_run`

Create and execute transition tests.

See [MCP Tools documentation](./mcp-tools/README.md) for details.

## State Persistence

FSM state persists via `DocumentStore`:

- Documents saved on every transition
- Restored on `initialize()` if storage exists
- Initial state entry actions only run on first initialization

Stop and restart FSM:

```typescript
// Run 1
const engine1 = new FSMEngine(fsm, { documentStore, scope });
await engine1.initialize(); // Loads from definition
await engine1.signal({ type: "START" });
// Documents persisted

// Run 2 (later)
const engine2 = new FSMEngine(fsm, { documentStore, scope });
await engine2.initialize(); // Loads from storage, maintains state
await engine2.signal({ type: "CONTINUE" });
```

## Recursion Protection

`emit` actions enqueue signals that trigger more transitions. Recursion depth
is capped at 10 to prevent infinite loops; exceeding the cap throws.

## Entry Actions

States can define entry actions that execute when the state is entered:

```yaml
states:
  processing:
    entry:
      - type: llm
        provider: anthropic
        model: claude-sonnet-4-6
        prompt: "Start processing"
      - type: emit
        event: PROCESSING_STARTED
```

Entry actions execute after transition actions, before the state becomes
active for further signal handling.

## Error Handling

Failed actions abort the transition — state doesn't change, error is thrown.
No automatic rollback or retry. LLM-action failures (provider error, schema
validation failure on `outputType`, validation-judge blocking verdict) all
surface as thrown errors that the workspace runtime catches and routes to the
job's error handling.

## Validation

Structural validation before execution:

```typescript
import { validateFSMStructure } from "@atlas/fsm-engine";

const result = validateFSMStructure(structure);

if (!result.valid) {
  console.error(result.errors);
  // [
  //   "Invalid transition in state \"pending\" on event \"APPROVE\": target \"approved\" does not exist.",
  //   "Document type \"OrderItem\" is referenced but not defined in documentTypes."
  // ]
}
```

Checks:

- Initial state exists
- A final state is declared
- All states reachable from `initial`
- Transition targets exist
- No stuck non-final states
- Referenced `documentTypes` are declared

## Dependencies

```json
{
  "imports": {
    "@atlas/core": "../core/mod.ts",
    "@atlas/llm": "../llm/mod.ts",
    "@atlas/logger": "../logger/mod.ts",
    "@atlas/utils": "../utils/mod.ts",
    "ai": "npm:ai@^5.0.93"
  }
}
```

## Security Considerations

**Document Validation**: JSON Schema validation provides runtime type safety.
Define strict schemas for all document types.

**LLM Calls**: Prompt injection possible via document data interpolation.
Sanitize sensitive documents before including in prompts.

**Tool Allowlist**: An LLM action's `tools:` array narrows the LLM's tool
surface. Use it to scope mutating tools (e.g. `send_email`) to actions that
explicitly need them.

## Limitations

- No transaction/rollback semantics — failed actions leave partial modifications
- No concurrent signal handling — signals queue and execute sequentially
- Recursion depth hardcoded to 10
- No built-in timeout handling for long-running actions

## What This Enables

- Define workflows in YAML without manual coding
- LLM-driven state transitions with document access
- Testable workflow logic with before/after assertions
- Workflow versioning via YAML in git
- LLM agents can generate and validate workflows via MCP tools
- State persistence across restarts
