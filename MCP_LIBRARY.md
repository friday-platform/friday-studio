# MCP Library Implementation - Atlas Platform

## Overview

This document describes the Atlas MCP Library implementation that enables agents to create, store,
and manage library items (reports, artifacts, templates, etc.) through the Model Context Protocol
(MCP) with automatic workspace context injection.

## ✅ Current Implementation Status

### **Implemented Features**

**1. Library Creation API Endpoint**

- `POST /api/library` - Create new library items through Atlas daemon
- Full validation with required fields (type, name, content)
- Automatic ID generation and timestamp management
- Support for all library item types: `report`, `session_archive`, `template`, `artifact`,
  `user_upload`

**2. MCP Library Store Tool**

- `library_store` - MCP tool for creating library items
- Comprehensive Zod v4 schema validation
- Automatic workspace context injection (workspace_id, session_id, agent_ids)
- Routes through daemon API for consistent storage and security

**3. Context Injection Architecture**

- Enhanced `PlatformMCPServer` with workspace context support
- Automatic injection when context parameters not provided
- Fallback to explicit parameters when needed
- Clean agent interfaces without hardcoded workspace references

**4. Topic-Summarizer Integration**

- Updated workspace configuration to include `atlas-platform` MCP server
- Agent configured with library tools access
- System prompt updated to use `library_store` for report creation
- Removed hardcoded workspace_id requirements

## Architecture Overview

### **Component Flow**

```
Agent Execution → MCP Tool Call → Platform MCP Server → Daemon API → Library Storage
     ↓                ↓               ↓                    ↓             ↓
  Context         Auto-inject    Route to daemon      Validate &     Store with
  Available       workspace      /api/library         Generate ID    metadata
                  context
```

### **Context Injection Flow**

1. **Agent Execution Worker** provides workspace context to MCP servers
2. **Platform MCP Server** receives context during initialization
3. **Library Store Tool** automatically injects context when parameters missing:
   ```typescript
   workspace_id: workspace_id || this.workspaceContext?.workspaceId;
   session_id: session_id || this.workspaceContext?.sessionId;
   agent_ids: agent_ids.length > 0 ? agent_ids : [this.workspaceContext?.agentId];
   ```
4. **Daemon API** validates and stores with complete metadata

### **Data Flow Architecture**

```yaml
# Agent Call (simplified)
library_store({
  type: "report",
  name: "AI Discovery Report",
  content: "# Report content...",
  tags: ["ai-discovery", "automated"]
})

# Auto-injected to Daemon API
{
  type: "report",
  name: "AI Discovery Report", 
  content: "# Report content...",
  workspace_id: "delicate_beans",    # ← Auto-injected
  session_id: "71f0498a-fb46...",    # ← Auto-injected
  agent_ids: ["topic-summarizer"],   # ← Auto-injected
  created_at: "2025-07-04T17:40:45.726Z",
  id: "0b45d44c-9d62-4d4b-8f52-b13ac26e984c"
}
```

## API Reference

### **Library Store Tool (`library_store`)**

**Description**: Create a new library item with automatic context injection

**Parameters**:

- `type` (required): `"report" | "session_archive" | "template" | "artifact" | "user_upload"`
- `name` (required): Human-readable name (max 255 chars)
- `description` (optional): Description of contents (max 1000 chars)
- `content` (required): The actual content to store
- `format` (optional): `"markdown" | "json" | "html" | "text" | "binary"` (default: "markdown")
- `tags` (optional): Array of tags for categorization (max 50 tags)
- `workspace_id` (optional): Auto-injected from context if not provided
- `session_id` (optional): Auto-injected from context if not provided
- `agent_ids` (optional): Auto-injected from context if not provided
- `source` (optional): `"agent" | "job" | "user" | "system"` (default: "agent")
- `metadata` (optional): Additional metadata object

**Returns**:

```json
{
  "success": true,
  "itemId": "uuid-string",
  "message": "Library item 'name' created",
  "item": {/* complete library item object */}
}
```

### **Daemon API Endpoint (`POST /api/library`)**

**Endpoint**: `POST http://localhost:8080/api/library`

**Request Body**:

```json
{
  "type": "report",
  "name": "Item Name",
  "description": "Optional description",
  "content": "Content to store",
  "format": "markdown",
  "tags": ["tag1", "tag2"],
  "workspace_id": "optional-workspace-id",
  "session_id": "optional-session-id",
  "agent_ids": ["agent1"],
  "source": "agent",
  "metadata": {}
}
```

**Response**: Same as MCP tool response above

## Usage Examples

### **Agent Integration**

```yaml
# In workspace.yml - Agent configuration
agents:
  topic-summarizer:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    tools:
      mcp: ["atlas-platform"] # Access to library tools
    prompts:
      system: |
        After generating your analysis, store it using:

        library_store({
          type: "report",
          name: "Analysis Report - [Date]",
          description: "Comprehensive analysis with insights",
          content: "[Your markdown report]",
          format: "markdown",
          tags: ["analysis", "automated"]
        });
```

### **MCP Server Configuration**

```yaml
# In workspace.yml - MCP server setup
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "stdio"
          command: "deno"
          args: [
            "run",
            "--allow-all",
            "/Users/sara/Projects/atlas/src/cli.tsx",
            "mcp",
            "serve",
          ]
        capabilities:
          tools:
            allowed: [
              "library_list",
              "library_get",
              "library_search",
              "library_store",
              "library_stats",
              "library_templates",
            ]
        timeout_ms: 30000
```

### **Direct API Usage**

```bash
# Create library item via API
curl -X POST http://localhost:8080/api/library \
  -H "Content-Type: application/json" \
  -d '{
    "type": "report",
    "name": "Test Report",
    "content": "# Test Content\n\nThis is a test report.",
    "format": "markdown",
    "tags": ["test", "example"],
    "workspace_id": "my-workspace"
  }'
```

## Current Limitations

### **Context Passing Gap**

- MCP server instantiated without workspace context in CLI `serve` command
- Context injection only works when MCP server has workspace context available
- Manual workspace configuration still required for each workspace

### **Configuration Duplication**

- Each workspace must manually configure `atlas-platform` MCP server
- Hardcoded file paths in workspace configurations
- No global MCP server configuration system

### **Limited Context Sources**

- Context only available during agent execution within workspace sessions
- CLI `mcp serve` command has no workspace context access
- No daemon API for workspace context lookup

## 🚀 Future Enhancements

### **Phase 1: Global MCP Server Configuration**

**Add to `atlas.yml`**:

```yaml
# Global MCP server definitions
mcp_servers:
  global:
    atlas-platform:
      transport:
        type: "stdio"
        command: "atlas"
        args: ["mcp", "serve"]
        env:
          ATLAS_DAEMON_URL: "http://localhost:8080"
      capabilities:
        tools:
          allowed: ["library_*", "workspace_*", "session_*"]
      auto_context: true
```

**Workspace Inheritance**:

```yaml
# Simplified workspace.yml
tools:
  mcp:
    inherit_global: true # Automatic atlas-platform access
    servers:
# Only workspace-specific servers needed here
```

### **Phase 2: Enhanced Context Passing**

**Agent Execution Enhancement**:

```typescript
// Pass context to all MCP servers during initialization
const mcpConfigService = new WorkspaceMCPConfigurationService(
  this.workspaceId,
  this.sessionId,
  resolvedMcpServerConfigs,
  {
    injectContext: true,
    contextData: {
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      agentId: request.agent_id,
    },
  },
);
```

**CLI Serve Enhancement**:

```typescript
// Enhanced serve command with daemon context lookup
export const handler = async (argv: McpServeArgs): Promise<void> => {
  const workspaceContext = await getDaemonWorkspaceContext(argv.daemonUrl);

  const mcpServer = new PlatformMCPServer({
    daemonUrl,
    logger,
    workspaceContext, // Dynamic context from daemon
  });
};
```

### **Phase 3: Advanced Library Features**

**Additional Library Tools**:

- `library_update` - Update existing library items
- `library_delete` - Remove library items with workspace access control
- `library_clone` - Duplicate items across workspaces
- `library_export` - Export items in various formats
- `library_import` - Import from external sources

**Advanced Context Features**:

- Cross-workspace library access with permissions
- Session-based library item versioning
- Agent collaboration on library items
- Library item workflow and approval systems

### **Phase 4: Enterprise Integration**

**Security & Access Control**:

- Role-based access to library operations
- Workspace-level library permissions
- Audit logging for library modifications
- Compliance features for data governance

**Performance & Scale**:

- Library item caching and indexing
- Bulk operations for large datasets
- Library analytics and usage metrics
- Integration with external storage systems

## Migration Guide

### **From Manual to Auto-Context**

**Before (Manual Context)**:

```typescript
library_store({
  type: "report",
  name: "Report",
  content: "...",
  workspace_id: "hardcoded-workspace",
  session_id: "hardcoded-session",
  agent_ids: ["hardcoded-agent"],
});
```

**After (Auto-Context)**:

```typescript
library_store({
  type: "report",
  name: "Report",
  content: "...",
  // workspace_id, session_id, agent_ids auto-injected
});
```

### **Workspace Configuration Migration**

**Before (No MCP Server)**:

```yaml
# workspace.yml - No library access
agents:
  my-agent:
    type: "llm"
    # No library tools available
```

**After (With Atlas Platform)**:

```yaml
# workspace.yml - Full library access
tools:
  mcp:
    servers:
      atlas-platform: { /* MCP server config */ }

agents:
  my-agent:
    type: "llm"
    tools:
      mcp: ["atlas-platform"]
```

## Troubleshooting

### **Common Issues**

**1. Library Store Tool Not Available**

- **Cause**: Agent not configured with atlas-platform MCP server access
- **Solution**: Add `mcp: ["atlas-platform"]` to agent tools configuration

**2. Context Not Auto-Injected**

- **Cause**: MCP server instantiated without workspace context
- **Solution**: Ensure agent execution provides context to MCP server initialization

**3. Hardcoded Workspace Errors**

- **Cause**: Agent prompts still contain hardcoded workspace references
- **Solution**: Update agent system prompts to use auto-injection

**4. API Endpoint Not Found**

- **Cause**: Daemon running old code without POST /api/library endpoint
- **Solution**: Restart Atlas daemon to pick up new API endpoints

### **Debug Commands**

```bash
# Test library creation via API
curl -X POST http://localhost:8080/api/library -d '{...}'

# List library items
deno task atlas library list

# Check daemon status
curl http://localhost:8080/api/daemon/status

# Validate workspace configuration
deno task atlas config validate
```

## Implementation Details

### **Files Modified**

1. **`apps/atlasd/src/atlas-daemon.ts`**
   - Added `POST /api/library` endpoint
   - Library item validation and storage
   - UUID generation and timestamp management

2. **`packages/mcp-server/src/platform-server.ts`**
   - Added `workspaceContext` interface and property
   - Implemented `library_store` MCP tool
   - Automatic context injection logic
   - Comprehensive Zod v4 validation schemas

3. **`examples/topic-summarizer/workspace.yml`**
   - Added `atlas-platform` MCP server configuration
   - Updated agent tools to include atlas-platform access
   - Modified system prompt to use library_store

### **Testing Verification**

```bash
# Test API endpoint works
curl -X POST http://localhost:8080/api/library -d '{
  "type": "report",
  "name": "Test Report", 
  "content": "Test content"
}'

# Verify library item created
deno task atlas library list

# Test agent integration (manual signal trigger)
curl -X POST http://localhost:8080/api/workspaces/delicate_beans/signals/manual-scan
```

---

**Status**: ✅ **Implementation Complete and Working**\
**Next Phase**: Global MCP Server Configuration\
**Documentation**: Complete with examples and troubleshooting guides
