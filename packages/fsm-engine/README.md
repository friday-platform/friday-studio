# FSM Engine

Direct finite state machine execution engine for Atlas. Defines workflows as
states, transitions, and actions. States store documents, transitions execute
TypeScript functions, call LLMs, or emit events.

## Features

- Load FSM definitions from YAML or build programmatically
- Execute state transitions with guard conditions
- Store typed documents in states with JSON Schema validation
- Execute actions: TypeScript functions, LLM calls, agent invocations, event
  emission
- Test transitions with before/after validation
- Serialize/restore FSMs from persistent storage
- MCP tools for FSM creation and testing

## Architecture

FSM workflows are defined in YAML with TypeScript code for guards and actions.
Queue-based signal processing with recursion protection. Documents persist
across transitions using `@atlas/document-store`.

### Components

- **FSMEngine**: Main executor - loads FSM definitions, compiles TypeScript
  functions, processes signals, manages documents
- **Serializer**: YAML ↔ FSM structure conversion with Zod validation
- **TestRunner**: Executes transition tests with state/document assertions
- **Validator**: Comprehensive structural validation with detailed error
  messages

### Code Execution

Guards and actions are defined as TypeScript code strings in the YAML
definition. At initialization, FSMEngine compiles these strings into executable
functions using dynamic imports via data URLs.

**SECURITY WARNING**: Code execution is currently unsandboxed and runs with full
process permissions. Only load FSM definitions from trusted sources. Sandboxing
via Deno workers will be implemented in a future change.

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
- **guards**: Functions returning boolean (all must pass)
- **actions**: Executed sequentially - LLM calls, code execution, event
  emission, agent invocation

Multiple transitions can handle the same event with different guards (first
matching guard wins).

### Signals

External inputs triggering transitions:

```typescript
{ type: "APPROVE", data: { approvedBy: "user-123" } }
```

Signals queue if FSM is processing. Executed in order.

### Actions

**Code Actions**: Execute TypeScript functions

```yaml
type: code
function: validateOrder # References functions.validateOrder
```

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

**Emit Actions**: Send events to external systems

```yaml
type: emit
event: order.approved
data: { orderId: "{{order.id}}" }
```

### Guards

Functions controlling transition execution:

```typescript
export function hasInventory(context, event) {
  const order = context.documents.find((d) => d.id === "order");
  return order.data.items.length > 0;
}
```

Guards receive context (documents, state) and event. Return boolean.

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

  tools:
    get_address:
      description: Get shipping address for an order
      inputSchema:
        type: object
        properties:
          orderId: { type: string }
        required: [orderId]
      code: |
        export default async function get_address(args, context) {
          // Fetch address from external service
          const response = await fetch(`https://api.example.com/orders/${args.orderId}/address`);
          return await response.json();
        }

  states:
    pending:
      documents:
        - id: order-001
          type: Order
          data: { items: ["laptop"], total: 1200, status: "pending" }

      on:
        APPROVE:
          target: approved
          guards: [hasInventory]
          actions:
            - type: code
              function: validateOrder
            - type: emit
              event: order.approved

    approved:
      type: final

  functions:
    hasInventory:
      type: guard
      code: |
        export default function hasInventory(context, event) {
          const order = context.documents[0];
          return order.data.items.length > 0;
        }

    validateOrder:
      type: action
      code: |
        export default function validateOrder(context, event) {
          const order = context.documents[0];
          context.updateDoc(order.id, { status: 'validated' });
        }
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

```typescript
import {
  codeAction,
  createFSM,
  emitAction,
  state,
  transition,
} from "@atlas/fsm-engine";

const fsm = createFSM({
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
    pending: state({
      documents: [{
        id: "order",
        type: "Order",
        data: { items: ["laptop"], total: 1200, status: "pending" },
      }],
      transitions: {
        APPROVE: transition("approved", [
          codeAction("validateOrder"),
          emitAction("order.approved", { orderId: "order-001" }),
        ], ["hasInventory"]),
      },
    }),
    approved: state({ final: true }),
  },
  functions: {
    hasInventory: {
      type: "guard",
      code:
        "export default function hasInventory(context, event) { return context.documents[0].data.items.length > 0; }",
    },
    validateOrder: {
      type: "action",
      code:
        "export default function validateOrder(context, event) { context.updateDoc('order', { status: 'validated' }); }",
    },
  },
});

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

### Tool Definitions

Tools are TypeScript functions that the LLM can call during generation:

```yaml
tools:
  get_customer_history:
    description: Retrieve customer order history
    inputSchema:
      type: object
      properties:
        customerId: { type: string }
      required: [customerId]
    code: |
      export default async function get_customer_history(args, context) {
        const response = await fetch(`https://api.example.com/customers/${args.customerId}/orders`);
        const history = await response.json();
        return { orders: history.orders, totalSpent: history.total };
      }
```

Tools receive:

- `args`: Tool arguments from LLM (validated against inputSchema)
- `context`: Current FSM context (documents, state)

Tools return any JSON-serializable value that's passed back to the LLM.

Configure LLM provider:

```typescript
import { AtlasLLMProviderAdapter } from "@atlas/fsm-engine";

const llmProvider = new AtlasLLMProviderAdapter(
  "claude-sonnet-4-6",
  "anthropic",
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

Create and validate an FSM definition. Accepts complete FSM structure with
TypeScript code strings for guards and actions.

```json
{
  "tool": "fsm_create",
  "arguments": {
    "definition": {
      "id": "order-processor",
      "initial": "pending",
      "documentTypes": { "Order": {...} },
      "states": { "pending": {...} },
      "functions": {
        "hasInventory": {
          "type": "guard",
          "code": "export default function hasInventory(context, event) { return context.documents[0].data.items.length > 0; }"
        },
        "validateOrder": {
          "type": "action",
          "code": "export default function validateOrder(context, event) { context.updateDoc('order', { status: 'validated' }); }"
        }
      }
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

Actions can emit signals that trigger more transitions. Recursion depth limited
to 10 to prevent infinite loops:

```typescript
// Action emits signal
export default function triggerNext(context, event) {
  context.emit({ type: "NEXT" }); // Triggers transition
}
```

Exceeding depth throws error.

## Entry Actions

States can define entry actions executed when entering:

```yaml
states:
  processing:
    entry:
      - type: code
        function: logEntry
      - type: llm
        provider: anthropic
        model: claude-sonnet-4-6
        prompt: "Start processing"
```

Entry actions execute after transition actions, before state becomes active.

## Error Handling

Failed actions abort transition - state doesn't change, error thrown. No
automatic rollback or retry. Handle errors in action code:

```typescript
export default function risky(context, event) {
  try {
    // Risky operation
  } catch (error) {
    context.updateDoc("error-log", { error: error.message });
    throw error; // Abort transition
  }
}
```

## Validation

Structural validation before execution:

```typescript
import { validateFSMStructure } from "@atlas/fsm-engine";

const result = validateFSMStructure(structure);

if (!result.valid) {
  console.error(result.errors);
  // [
  //   "State 'pending' references undefined guard 'hasInventory'",
  //   "Undefined document type: OrderItem"
  // ]
}

console.log(result.warnings);
// ["No agent failure handling detected"]
```

Checks:

- Initial state exists
- All states reachable
- Transition targets exist
- Guards and actions defined
- Document types declared
- Fields exist in schemas

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

**IMPORTANT - Code Execution**: Guards and actions currently execute via dynamic
import of user-provided strings. This runs in the same process with full
permissions and represents a significant security risk. **Only load FSM
definitions from trusted sources.** Arbitrary code execution will be addressed
with Deno worker sandboxing in the next change before this is used in
production.

**Document Validation**: JSON Schema validation provides runtime type safety.
Define strict schemas for all document types.

**LLM Calls**: Prompt injection possible via document data interpolation.
Sanitize sensitive documents before including in prompts.

## Limitations

- No transaction/rollback semantics - failed actions leave partial modifications
- No concurrent signal handling - signals queue and execute sequentially
- Code execution unsandboxed - full process access (will be addressed in next
  change)
- Recursion depth hardcoded to 10
- No built-in timeout handling for long-running actions
- Tool execution happens in main process (will be sandboxed with code execution)

## What This Enables

- Define workflows in YAML without manual coding
- LLM-driven state transitions with document access
- Testable workflow logic with before/after assertions
- Workflow versioning via YAML in git
- LLM agents can generate and validate workflows via MCP tools
- State persistence across restarts
