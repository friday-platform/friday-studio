# Atlas Conversational UX Architecture

## Overview

Atlas provides a conversational user experience where users interact with AI supervisors and agents
through a chatroom-style interface. Instead of traditional command-line operations, users engage in
natural language conversations with the appropriate Atlas components based on their current context.

## Core Concept: Chatroom Architecture

The conversational UX operates as a **chatroom** where:

- **Users** communicate in natural language
- **AI Supervisors and Agents** participate as chat participants
- **Conversation Facilitator** (non-AI) manages the chat mechanics
- **Participants dynamically join/leave** based on context

## Architecture Components

### Conversation Facilitator (Non-AI)

**Responsibilities:**

- Manages chat UI/output buffer
- Routes messages between participants
- Handles participant joining/leaving
- Maintains conversation history
- Context detection and participant management

**NOT Responsible For:**

- AI decision making
- Content generation
- Business logic

### Dynamic Participants

Participants join the conversation based on the user's current context:

#### Root Context: `atlas`

```
Participants: [PlatformSupervisor]
```

#### Workspace Context: `atlas` (in workspace folder)

```
Participants: [PlatformSupervisor, WorkspaceSupervisor]
```

#### Context Switching: `/workspace switch <name>`

```
Participants: [PlatformSupervisor, NewWorkspaceSupervisor]
└── OldWorkspaceSupervisor leaves, NewWorkspaceSupervisor joins
```

#### Session Context: Active session

```
Participants: [PlatformSupervisor, WorkspaceSupervisor, SessionSupervisor, RelevantAgents]
```

## Supervisor Roles (Single Responsibility Principle)

### PlatformSupervisor

**Scope:** Global Atlas platform concerns **Responsibilities:**

- Global Atlas configuration
- Cross-workspace operations
- Platform-level resource management
- Atlas daemon coordination
- CLI root command concerns
- Multi-workspace orchestration

**Examples:**

- "Show all workspaces"
- "Start Atlas daemon"
- "Global configuration changes"

### WorkspaceSupervisor

**Scope:** Individual workspace management **Responsibilities:**

- Workspace-specific signal analysis
- Job configuration and routing
- Workspace resource management
- Local agent coordination

**Examples:**

- "Deploy this workspace"
- "What signals are available?"
- "Trigger the webhook handler"

### SessionSupervisor

**Scope:** Execution session management **Responsibilities:**

- Execution plan creation and management
- Agent coordination within sessions
- Session-scoped memory and context
- Real-time execution monitoring

**Examples:**

- "How's the deployment going?"
- "Show execution plan"
- "What agents are currently running?"

### AgentSupervisor + Agents

**Scope:** Individual agent execution and safety **Responsibilities:**

- Agent safety analysis and validation
- Execution environment preparation
- Agent output validation
- Direct agent interaction

**Examples:**

- "Run kubectl get pods"
- "Check database connectivity"
- "Validate this configuration"

## Context Detection Logic

The Conversation Facilitator detects context and manages participants:

### Initial Context Detection

```typescript
// Detect workspace context on startup
const cwd = Deno.cwd();
const hasWorkspace = await exists(path.join(cwd, "workspace.yml"));

if (hasWorkspace) {
  participants = [PlatformSupervisor, WorkspaceSupervisor];
} else {
  participants = [PlatformSupervisor];
}
```

### Dynamic Context Changes

```typescript
// Workspace switching
'/workspace switch backend' -> {
    remove: [CurrentWorkspaceSupervisor],
    add: [BackendWorkspaceSupervisor]
}

// Session activation  
'session active' -> {
    add: [SessionSupervisor, RelevantAgents]
}

// Leave workspace context
'/workspace leave' -> {
    remove: [WorkspaceSupervisor, SessionSupervisor, Agents]
}
```

## User Experience Flow

### Example: Root Context

```
User: atlas
[PlatformSupervisor joins chat]

User: "What workspaces are available?"
PlatformSupervisor: "I found 3 workspaces: backend, frontend, ml-pipeline..."

User: "Switch to backend"
[WorkspaceSupervisor(backend) joins chat]
```

### Example: Workspace Context

```
User: "Help me deploy the latest version"
WorkspaceSupervisor: "I can trigger the deploy-prod signal. Let me check if everything is ready..."
PlatformSupervisor: "All global prerequisites are met for deployment."

[SessionSupervisor joins as deployment session starts]
SessionSupervisor: "Created execution plan: build -> test -> deploy. Starting now..."
```

### Example: Multi-Participant Conversation

```
User: "Something seems wrong with the database connection"
WorkspaceSupervisor: "I can trigger the db-health-check signal"
AgentSupervisor: "I need to validate the connection parameters first for security"
DatabaseAgent: "Connection failed: timeout after 5000ms to postgres://..."
SessionSupervisor: "I'll coordinate the diagnosis and fix sequence"
```

## Implementation Architecture

### Technology Stack

- **UI Framework:** Ink (React for CLI) with existing output buffer
- **State Management:** React hooks for participant management
- **Communication:** Direct supervisor/agent invocation (same process)
- **Context Detection:** File system watching + command parsing
- **Message Routing:** Simple participant registry and message dispatch

### Integration with Existing Code

- **Adds to:** Slash command system in interactive.tsx (conversational interface alongside existing
  commands)
- **Reuses:** Output buffer, workspace detection, daemon client
- **Extends:** Existing supervisor LLM capabilities for conversation
- **Maintains:** All existing Atlas functionality and APIs
- **Leverages:** Supervisors can invoke existing slash commands and underlying tools during
  conversations

## The Conference Room: Human Behavioral Expectations

### Natural Conversational Expectations

When users interact with the Atlas conversational interface, they bring sophisticated human
behavioral expectations from real-world group conversations. Using the **conference room analogy**:
when someone speaks at a meeting table, everyone present hears what was said and can respond
contextually.

**User expectations include:**

**Ambient Awareness**

- All participants should be "listening" to the ongoing conversation
- Relevant experts should have context about what's been discussed
- Information shouldn't need to be manually repeated to different participants

**Contextual Participation**

- When someone mentions a session ID, the SessionSupervisor should already know about it
- If deployment is discussed, both WorkspaceSupervisor and relevant agents should be aware
- Participants should join conversations naturally when their domain is mentioned

**Natural Information Flow**

- Users shouldn't need to manually relay information between AI participants
- Follow-up questions should build on the full conversation context
- Participants should reference and build upon each other's contributions

### The Fundamental Technical Constraint

However, these natural expectations conflict with **LLM API limitations**:

**What users expect:**

```
User: "What's the status of the backend deployment?"
WorkspaceSupervisor: "Deployment started 5 minutes ago with session sess_123"
SessionSupervisor: [automatically aware] "That session is 60% complete, currently in build phase"
User: "Any issues?"
SessionSupervisor: [knows full context] "No issues, proceeding normally based on the deployment WorkspaceSupervisor mentioned"
```

**What's technically possible:**

```
User: "What's the status of the backend deployment?"
WorkspaceSupervisor: [only sees this user message] "Deployment started 5 minutes ago with session sess_123"
User: "SessionSupervisor, how is session sess_123 going?"
SessionSupervisor: [only sees this user message, no context about deployment] "Please provide more context about this session"
```

**The core problem:** Each supervisor operates in an isolated conversation bubble. They cannot
"overhear" what other participants have said, requiring the user to act as an information relay
between AI participants.

### Technical Constraint Details

**LLM API Limitations:**

- Only supports `user/assistant` role pairs in conversation history
- Cannot send multi-participant conversation context like:
  ```typescript
  // This is invalid - APIs reject custom roles
  [
    { role: "user", content: "what's the deployment status?" },
    { role: "WorkspaceSupervisor", content: "Deployment started with session sess_123" },
    { role: "SessionSupervisor", content: "That session is 60% complete" },
  ];
  ```

**Multiplexing Reality:**

- Each supervisor maintains separate `user/assistant` conversation threads
- No native way to share conversation context between supervisors
- User becomes the manual information bridge between AI participants

### Potential Workarounds

**Option 1: Context Injection in Content**

```typescript
// When SessionSupervisor responds, inject relevant context
{
  role: "user", 
  content: "Context: WorkspaceSupervisor previously said 'Deployment started with session sess_123'. User asks: how's that session going?"
}
```

_Pros:_ Provides context without breaking API constraints\
_Cons:_ Artificial, may confuse LLM about conversation flow

**Option 2: Selective Cross-Supervisor Context**

- When supervisor mentions session ID/workspace name, automatically provide that context to relevant
  supervisors
- Maintain context graphs of related information
- Intelligent context sharing based on topic analysis

_Pros:_ More natural information flow\
_Cons:_ Complex to implement, may lead to context pollution

**Option 3: Accept User-as-Relay Model**

- Design UX to make manual information relay feel natural
- Clear visual indicators of who's "listening"
- Easy mechanisms to address specific participants
- Accept that users will need to bridge information gaps

_Pros:_ Simple, predictable, works within API constraints\
_Cons:_ Doesn't meet full human behavioral expectations

### Design Decision Required

The tension between **natural human expectations** and **technical constraints** represents a
fundamental design challenge. The conversational UX must either:

1. **Meet human expectations** through complex workarounds that may feel artificial
2. **Accept limitations** while designing UX that makes the constraints feel natural
3. **Hybrid approach** with selective context sharing for high-value scenarios

This decision will significantly impact both implementation complexity and user experience quality.

## Multi-LLM Conversation Multiplexing

### Constraint: LLM APIs Don't Support Custom Roles

Standard LLM APIs (Claude, OpenAI) only support fixed roles:

- **Claude API:** `"user"`, `"assistant"`
- **OpenAI API:** `"system"`, `"user"`, `"assistant"`, `"function"`

**No custom roles** like `"platform_supervisor"` or `"workspace_supervisor"` are supported.

### Solution: Conversation Multiplexing

Instead of trying to force multiple participants into a single LLM conversation, we **multiplex
separate LLM conversations** into a unified chat experience.

#### Architecture

**Behind the Scenes:**

- Each supervisor maintains its **own separate LLM conversation thread**
- PlatformSupervisor has: `[{role: "user", content: "..."}, {role: "assistant", content: "..."}]`
- WorkspaceSupervisor has: `[{role: "user", content: "..."}, {role: "assistant", content: "..."}]`
- SessionSupervisor has: `[{role: "user", content: "..."}, {role: "assistant", content: "..."}]`
- Each maintains full conversation context independently

**User Input Processing:**

1. User: `"help me deploy the backend"`
2. Conversation Facilitator determines relevant participants:
   `[WorkspaceSupervisor, PlatformSupervisor]`
3. **Parallel LLM API calls** - each supervisor processes the user message in their own conversation
   context
4. Responses received:
   - WorkspaceSupervisor: `"I can trigger the deploy-prod signal..."`
   - PlatformSupervisor: `"All global prerequisites are met..."`

**Display Linearization:** The user sees a unified conversation:

```
User: help me deploy the backend
WorkspaceSupervisor: I can trigger the deploy-prod signal...
PlatformSupervisor: All global prerequisites are met...
User: start it
WorkspaceSupervisor: Triggering deployment now...
```

#### Benefits

- **Rich Context:** Each supervisor maintains full conversation history and context
- **API Compliance:** All LLM calls use standard user/assistant roles
- **Natural Experience:** User sees seamless multi-participant conversation
- **Dynamic Participants:** Can add/remove supervisors without losing individual conversation
  contexts
- **Leverages Existing Architecture:** Uses Atlas's existing LLM-enabled supervisors

#### Implementation Details

```typescript
interface SupervisorConversation {
  supervisorId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt: string;
}

interface ConversationState {
  participants: Map<string, SupervisorConversation>;
  displayHistory: Array<{ speaker: string; content: string; timestamp: Date }>;
}

// When user sends message
async function processUserMessage(input: string) {
  const relevantParticipants = determineParticipants(input);

  const responses = await Promise.all(
    relevantParticipants.map(async (participant) => {
      // Add user message to participant's conversation
      participant.messages.push({ role: "user", content: input });

      // Make LLM API call with participant's full conversation context
      const response = await anthropic.messages.create({
        model: "claude-3-sonnet",
        messages: participant.messages,
      });

      // Add response to participant's conversation
      participant.messages.push({ role: "assistant", content: response.content });

      return {
        speaker: participant.supervisorId,
        content: response.content,
      };
    }),
  );

  // Add all responses to display history
  responses.forEach((response) => {
    displayHistory.push({
      speaker: response.speaker,
      content: response.content,
      timestamp: new Date(),
    });
  });
}
```

## Next Steps

1. **Design Conversation Facilitator** - Message routing and participant management
2. **Implement Participant Registry** - Dynamic joining/leaving logic
3. **Create Natural Language Input** - Replace slash commands with NL processing
4. **Build Supervisor Chat Integration** - Enable supervisors to participate in conversations
5. **Context Detection System** - Automatic participant management based on user context
6. **Message History and Context** - Maintain conversation continuity across context switches
7. **Implement Conversation Multiplexing** - Build the parallel LLM conversation coordination system
