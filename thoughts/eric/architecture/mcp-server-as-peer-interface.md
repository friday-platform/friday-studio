# Platform MCP Server as Peer Interface

## Architectural Insight

The current model treats Platform MCP Server as a client of the daemon, but that's actually creating unnecessary complexity. Let's reconsider:

### Current Thinking (Problematic)
```
Conversation Agent → MCP Protocol → Platform MCP Server
                                            ↓
                                      HTTP Client
                                            ↓
                                     Daemon HTTP API
                                            ↓
                                    Workspace Runtime
```

### Revised Thinking (Clean)
```
Conversation Agent → MCP Protocol → Platform MCP Server ─┐
                                                          ├→ Workspace Runtime
Web UI → HTTP REST → Daemon HTTP API ────────────────────┘
```

## The Philosophical Shift

**FROM**: Platform MCP Server is a thin wrapper/client of daemon HTTP endpoints
**TO**: Platform MCP Server is a peer interface that directly accesses Atlas runtime

Both the daemon (HTTP) and Platform MCP Server (MCP) are **network interfaces to the same core system**, just using different protocols for different use cases:

- **Daemon HTTP**: RESTful API for web clients, CLI tools, general integration
- **Platform MCP**: Model Context Protocol for AI agents and LLM tool usage

## Why This Makes Sense

1. **Protocol != Service Boundary**: Service boundaries should reflect business logic separation, not protocol differences. GraphQL and REST endpoints commonly share the same service layer.

2. **Notification Simplicity**: With direct runtime access, the Platform MCP Server can:
   - Maintain object references to notification emitters
   - Stream events directly without HTTP serialization
   - Handle bidirectional communication naturally

3. **First-Class Interface**: MCP isn't subordinate to HTTP - it's an alternative interface optimized for AI agent interaction.

4. **Similar to Agent Server**: The Agent Server already acts as a direct interface to the runtime for agent execution - Platform MCP Server should follow the same pattern for workspace operations.

## Implementation Implications

For jobs-as-tools, this means:

```typescript
// Platform MCP Server with direct runtime access
class PlatformMCPServer {
  private workspaceManager: WorkspaceManager; // Direct reference

  async executeJobTool(jobName: string, params: unknown) {
    // Direct runtime access
    const runtime = await this.workspaceManager.getRuntime(workspaceId);

    // Create notification channel directly
    const notifier = (event) => {
      this.server.notification({
        method: "notifications/tool/streamContent",
        params: { toolName, sessionId, event }
      });
    };

    // Pass notifier directly to session (no HTTP boundary)
    const session = await runtime.triggerJobWithNotifier(
      jobName,
      params,
      notifier  // Direct function reference!
    );

    return await session.waitForCompletion();
  }
}
```

No registry pattern needed, no serialization complexity - just direct runtime interaction with notification callbacks.

## The Pragmatic Approach

- **Use HTTP where convenient**: For simple request/response operations, HTTP endpoints are fine
- **Use direct runtime access where necessary**: For streaming, notifications, complex state management
- **Maintain service boundaries**: Both interfaces respect the same business logic boundaries
- **Share core abstractions**: WorkspaceManager, SessionSupervisor, etc. are accessed by both

This isn't abandoning architectural principles - it's recognizing that **the Platform MCP Server and daemon are peer interfaces**, not a client-server relationship. They're both first-class citizens in the Atlas architecture, just speaking different protocols to different audiences.