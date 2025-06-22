# MCP and EMCP Unification Strategy

## Executive Summary

Atlas currently has two complementary MCP implementations that serve distinct purposes:

- **EMCP (Extended Model Context Protocol)**: Enterprise context provisioning system for loading
  data into agents
- **MCP (Model Context Protocol)**: Standard MCP integration for tool execution via Vercel AI SDK

This document analyzes both implementations and proposes a unified strategy that preserves their
strengths while providing clear integration paths.

## Current Implementation Analysis

### EMCP Implementation (`src/core/emcp/`)

**Purpose**: Extended Model Context Protocol - Atlas-specific extension for enterprise context
provisioning

**Architecture**:

```
EMCPRegistry
├── Provider Registration & Discovery
├── Capability Indexing
├── Confidence-based Selection
└── Cost Tracking

BaseEMCPProvider (Abstract)
├── Initialization & Lifecycle
├── Resource Management
├── Context Provisioning
└── Utility Methods

FilesystemProvider (Concrete)
├── File Pattern Matching
├── Security Validation
├── Content Aggregation
└── CRUD Operations
```

#### How EMCP Works - Deep Dive

**1. Provider Registration Flow**:

```typescript
// Step 1: Create a provider instance
const fsProvider = new FilesystemProvider();

// Step 2: Register with the EMCP Registry
await emcpRegistry.registerProvider(
  "workspace-files", // Provider ID
  fsProvider, // Provider instance
  new Map([ // Source configurations
    ["projectFiles", {
      basePath: "/workspace/src",
      allowedExtensions: [".ts", ".js"],
      maxFileSize: "50kb",
    }],
  ]),
);

// Registry internally:
// - Calls provider.initialize() with merged configs
// - Indexes provider capabilities for discovery
// - Maintains provider lifecycle
```

**2. Context Provisioning Flow**:

```typescript
// When an agent needs codebase context:
const contextSpec: CodebaseContextSpec = {
  type: "codebase",
  filePatterns: ["**/*.ts", "**/*.md"],
  focusAreas: ["Implement user authentication"],
  maxSize: "100kb",
};

// Registry finds best provider:
const result = await emcpRegistry.provisionContext(
  "codebase", // Context type
  contextSpec, // What to load
  { // Execution context
    workspaceId: "ws-123",
    sessionId: "sess-456",
    agentId: "code-analyzer",
    reasoning: "Need to understand auth implementation",
  },
);

// Returns EMCPResult with:
// - success: boolean
// - content: { uri, mimeType, content, metadata }
// - cost: { processingTimeMs, dataTransferBytes }
```

**3. Provider Discovery & Confidence Scoring**:

```typescript
// Registry discovers capable providers
const discoveries = emcpRegistry.discoverProviders("codebase");
// Returns sorted by confidence:
[
  {
    providerId: "workspace-files",
    capabilities: [...],
    canHandle: true,
    confidence: 0.85  // High - has all needed operations
  },
  {
    providerId: "git-provider",
    capabilities: [...],
    canHandle: true,
    confidence: 0.65  // Lower - missing some operations
  }
]
```

**4. Actual Content Loading (FilesystemProvider)**:

````typescript
// Inside FilesystemProvider.provisionContext():
async provisionContext(spec: CodebaseContextSpec, context: EMCPContext) {
  let codebaseContent = "";
  
  // Add focus areas as context
  if (spec.focusAreas?.length > 0) {
    codebaseContent += "# Analysis Focus Areas\n\n";
    spec.focusAreas.forEach((area, i) => {
      codebaseContent += `${i + 1}. ${area}\n`;
    });
  }
  
  // Process file patterns
  for (const pattern of spec.filePatterns) {
    // Use glob to find files
    const files = await expandGlob(pattern);
    
    // Load and aggregate content
    for (const file of files) {
      const content = await Deno.readTextFile(file.path);
      codebaseContent += `## ${file.name}\n`;
      codebaseContent += "```typescript\n";
      codebaseContent += content;
      codebaseContent += "\n```\n\n";
    }
  }
  
  return {
    success: true,
    content: {
      uri: "codebase://workspace",
      mimeType: "text/markdown",
      content: codebaseContent
    },
    cost: {
      processingTimeMs: 125,
      dataTransferBytes: codebaseContent.length
    }
  };
}
````

**5. Resource Operations**:

```typescript
// List available resources
const resources = await provider.listResources(context);
// Returns: [
//   { uri: "file:///src/auth.ts", type: "file", name: "auth.ts", size: 2048 },
//   { uri: "file:///src/user.ts", type: "file", name: "user.ts", size: 1536 }
// ]

// Read specific resource
const result = await provider.readResource("file:///src/auth.ts", context);
// Returns file content with cost metrics
```

**6. Security & Validation**:

```typescript
// FilesystemProvider enforces security
private async validatePath(filePath: string): Promise<void> {
  // Check denied paths
  for (const denied of this.deniedPaths) {
    if (filePath.startsWith(denied)) {
      throw new Error(`Access denied: ${denied}`);
    }
  }
  
  // Check allowed directories
  if (this.allowedDirectories.length > 0) {
    const allowed = this.allowedDirectories.some(dir => 
      filePath.startsWith(dir)
    );
    if (!allowed) {
      throw new Error(`Path not in allowed directories`);
    }
  }
}
```

**Key Concepts**:

- **Providers**: Plugins that know how to fetch specific types of context
- **Registry**: Manages providers, routes requests, tracks costs
- **Context Specs**: Typed definitions of what context to load
- **Cost Tracking**: Every operation measures time, data transfer, API calls
- **Security**: Path validation, read-only modes, access controls

**Strengths**:

- Extensible provider model for new context types
- Built-in cost measurement (tokens, API calls, processing time, data transfer)
- Security-first design with authentication/authorization support
- Confidence-based provider selection for optimal resource matching
- Clean abstraction with base provider class
- Sophisticated file handling with glob patterns and security controls

**Limitations**:

- Custom protocol (not standard MCP)
- Limited to context provisioning (no tool execution)
- Requires implementing custom providers for each source
- No integration with existing MCP ecosystem

### MCP Implementation (`src/core/agents/mcp/`)

**Purpose**: Standard MCP integration using Vercel AI SDK for tool execution

**Architecture**:

```
MCPServerRegistry
├── Hierarchical Configuration (Platform → Workspace → Agent)
├── Configuration Merging
└── Server Management

MCPManager
├── Client Lifecycle Management
├── Transport Handling (SSE, stdio)
├── Tool Filtering & Discovery
└── Telemetry Integration
```

#### How MCP Works - Deep Dive

**1. Server Registration Flow**:

```typescript
// Step 1: Define server configuration
const githubServerConfig: MCPServerConfig = {
  id: "github",
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  auth: {
    type: "bearer",
    token_env: "GITHUB_TOKEN", // Read from env
  },
  tools: {
    allowed: ["create_issue", "search_code", "create_pr"],
    denied: ["delete_repo"], // Never allow this
  },
  timeout_ms: 30000,
};

// Step 2: Register with MCP Manager
await mcpManager.registerServer(githubServerConfig);

// Manager internally:
// - Creates Vercel AI SDK MCP client
// - Starts stdio process or connects to SSE endpoint
// - Validates connection and available tools
```

**2. Hierarchical Configuration Resolution**:

```typescript
// Platform config (atlas.yml)
const atlasConfig = {
  mcp_servers: {
    github: {
      transport: { type: "stdio", command: "github-mcp" },
      tools: { denied: ["delete_repo", "force_push"] },
    },
  },
};

// Workspace config (workspace.yml)
const workspaceConfig = {
  mcp_servers: {
    github: {
      tools: {
        allowed: ["create_issue", "search_code"],
        denied: ["create_pr"], // Workspace adds restriction
      },
    },
  },
};

// Registry merges: workspace overrides platform
MCPServerRegistry.initialize(atlasConfig, workspaceConfig);
// Result: GitHub server with combined denied list
```

**3. Tool Discovery & Execution**:

```typescript
// Get tools from specific servers
const tools = await mcpManager.getToolsForServers(["github", "search"]);

// Returns merged tools object:
{
  "create_issue": {
    description: "Create a GitHub issue",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } }
      }
    }
  },
  "search_web": {
    description: "Search the web",
    inputSchema: {
      type: "object", 
      properties: {
        query: { type: "string" }
      }
    }
  }
}
```

**4. Transport Types in Action**:

**STDIO Transport** (subprocess):

```typescript
// GitHub MCP server via stdio
const stdioConfig: MCPServerConfig = {
  id: "github",
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
};

// Manager spawns subprocess and communicates via stdin/stdout
// Perfect for local tools and servers
```

**SSE Transport** (HTTP):

```typescript
// Remote MCP server via Server-Sent Events
const sseConfig: MCPServerConfig = {
  id: "corporate-search",
  transport: {
    type: "sse",
    url: "https://mcp.company.com/search",
  },
  auth: {
    type: "api_key",
    token_env: "COMPANY_API_KEY",
    header: "X-API-Key",
  },
};

// Manager connects via HTTP SSE for remote servers
// Ideal for cloud-hosted MCP endpoints
```

**5. Tool Filtering & Security**:

```typescript
// Original tools from server
const rawTools = {
  "create_issue": {/* ... */},
  "delete_repo": {/* ... */},
  "search_code": {/* ... */},
  "admin_action": {/* ... */},
};

// After filtering with config
const filtered = mcpManager.filterTools(rawTools, {
  allowed: ["create_issue", "search_code"], // Whitelist
  denied: ["admin_action"], // Blacklist
});
// Result: Only create_issue and search_code available
```

**6. Telemetry & Observability**:

```typescript
// All MCP operations are traced
await AtlasTelemetry.withMCPSpan(
  "github",
  "tool_call",
  async (span) => {
    span.setAttribute("mcp.tool_name", "create_issue");
    span.setAttribute("mcp.server_id", "github");

    const result = await mcpClient.callTool("create_issue", {
      title: "Bug: Login not working",
      body: "Users report login failures",
    });

    span.setAttribute("mcp.success", true);
    return result;
  },
);
```

**7. Lifecycle Management**:

```typescript
// Graceful shutdown
await mcpManager.dispose();
// - Closes all client connections
// - Terminates stdio processes
// - Cleans up resources
// - Logs disposal metrics
```

**8. Real-World Usage Example**:

```typescript
// In an LLM agent that needs GitHub tools
class CodeReviewAgent {
  async reviewPR(prNumber: number) {
    // Get GitHub tools
    const tools = await mcpManager.getToolsForServers(["github"]);

    // Use with LLM
    const response = await generateText({
      model: anthropic("claude-3"),
      tools, // Pass MCP tools directly to LLM
      prompt: `Review PR #${prNumber} and create issues for any bugs`,
      toolChoice: "auto",
    });

    // LLM can now call GitHub tools directly
  }
}
```

**Key Concepts**:

- **Servers**: External processes or HTTP endpoints providing tools
- **Transports**: How to connect (stdio for local, SSE for remote)
- **Tools**: Functions the server exposes (with JSON Schema validation)
- **Filtering**: Security layer to control tool access
- **Registry**: Hierarchical config resolution for multi-tenant setups

**Strengths**:

- Native MCP protocol support through Vercel AI SDK
- Seamless integration with existing MCP ecosystem
- Built-in telemetry with OpenTelemetry spans
- Flexible transport options for different server types
- Hierarchical configuration for multi-tenant scenarios
- Type-safe configuration with Zod validation

**Limitations**:

- Limited to tool execution (no context provisioning)
- Dependent on Vercel AI SDK's experimental API
- No enterprise features like cost tracking
- No provider abstraction for extending functionality
- Transport-specific implementation details

## Critical Insight: Complementary Systems

These implementations serve fundamentally different purposes in the Atlas architecture:

| Aspect        | EMCP                            | MCP                            |
| ------------- | ------------------------------- | ------------------------------ |
| **Purpose**   | Context/Resource provisioning   | Tool/Action execution          |
| **Direction** | Input to agents                 | Capabilities for agents        |
| **Focus**     | "What agents need to know"      | "What agents can do"           |
| **Examples**  | Loading codebase, fetching data | Running commands, calling APIs |
| **Protocol**  | Atlas-specific extension        | Standard MCP                   |

### Visual Comparison

````
EMCP (Context Loading)                    MCP (Tool Execution)
┌─────────────────────┐                   ┌─────────────────────┐
│   Agent Request:    │                   │   Agent Request:    │
│ "I need to analyze  │                   │ "Create a GitHub    │
│  the auth code"     │                   │  issue for this"    │
└──────────┬──────────┘                   └──────────┬──────────┘
           │                                         │
           ▼                                         ▼
┌─────────────────────┐                   ┌─────────────────────┐
│  EMCP Registry      │                   │  MCP Manager        │
│  - Find providers   │                   │  - Find servers     │
│  - Score confidence │                   │  - Filter tools     │
└──────────┬──────────┘                   └──────────┬──────────┘
           │                                         │
           ▼                                         ▼
┌─────────────────────┐                   ┌─────────────────────┐
│ FilesystemProvider  │                   │ GitHub MCP Server   │
│ - Read auth.ts      │                   │ - create_issue()    │
│ - Read user.ts      │                   │ - Parameters valid? │
│ - Aggregate content │                   │ - Execute action    │
└──────────┬──────────┘                   └──────────┬──────────┘
           │                                         │
           ▼                                         ▼
┌─────────────────────┐                   ┌─────────────────────┐
│   Return Content:   │                   │   Return Result:    │
│ "## auth.ts         │                   │ { success: true,    │
│  ```typescript      │                   │   issue_url: "..." }│
│  export function... │                   │                     │
└─────────────────────┘                   └─────────────────────┘
````

### When to Use Each System

**Use EMCP when you need to:**

- Load files from the filesystem
- Fetch database schemas or sample data
- Retrieve API documentation
- Aggregate multiple resources into context
- Track costs of data loading
- Enforce security boundaries on data access

**Use MCP when you need to:**

- Execute shell commands
- Call external APIs
- Create/update GitHub issues
- Search the web
- Run database queries
- Perform any active operation

### Real-World Example: Code Review Task

```typescript
// Task: Review authentication code and create issues for problems

// 1. Use EMCP to load the code context
const codeContext = await emcpRegistry.provisionContext(
  "codebase",
  {
    type: "codebase",
    filePatterns: ["src/auth/**/*.ts", "src/middleware/auth.ts"],
    focusAreas: ["Security vulnerabilities", "Best practices"],
    maxSize: "50kb",
  },
  { workspaceId: "ws-123", sessionId: "sess-456", agentId: "reviewer" },
);

// 2. Send context to LLM for analysis
const analysis = await generateText({
  model: anthropic("claude-3"),
  prompt: `Review this authentication code:\n\n${codeContext.content.content}`,
});

// 3. Use MCP to create GitHub issues for findings
const tools = await mcpManager.getToolsForServers(["github"]);
const issues = await tools.create_issue({
  title: "Security: Passwords stored in plain text",
  body: analysis.findings[0].description,
  labels: ["security", "high-priority"],
});
```

This example shows how EMCP loads the context (input) while MCP executes actions (output).

## Unified Implementation Strategy

### 1. Maintain Separation with Clear Boundaries

Keep both implementations but clarify their distinct roles:

```typescript
// Clear separation of concerns
interface AgentCapabilities {
  // EMCP: Context provisioning (input)
  context: {
    providers: IEMCPProvider[];
    loadCodebase(spec: CodebaseContextSpec): Promise<string>;
    loadDatabase(spec: DatabaseContextSpec): Promise<string>;
    loadAPI(spec: APIContextSpec): Promise<string>;
  };

  // MCP: Tool execution (actions)
  tools: {
    servers: MCPServerConfig[];
    executeGitHub(action: string, args: unknown): Promise<unknown>;
    executeSearch(query: string): Promise<unknown>;
    executeCustom(tool: string, args: unknown): Promise<unknown>;
  };
}
```

### 2. Create Unified Agent Interface

Implement a unified interface that agents can use to access both systems:

```typescript
export class UnifiedCapabilityManager {
  constructor(
    private emcpRegistry: EMCPRegistry,
    private mcpManager: MCPManager,
  ) {}

  // Context provisioning via EMCP
  async provisionContext(
    type: string,
    spec: ContextSpec,
    context: EMCPContext,
  ): Promise<EMCPResult> {
    return await this.emcpRegistry.provisionContext(type, spec, context);
  }

  // Tool execution via MCP
  async getTools(serverIds: string[]): Promise<Record<string, unknown>> {
    return await this.mcpManager.getToolsForServers(serverIds);
  }

  // Unified discovery
  async discoverCapabilities(need: string): Promise<CapabilityDiscovery> {
    const contextProviders = this.emcpRegistry.discoverProviders(need);
    const toolServers = this.mcpManager.listServers()
      .filter((id) => this.canHandleNeed(id, need));

    return {
      context: contextProviders,
      tools: toolServers,
      recommendation: this.recommendBestOption(contextProviders, toolServers, need),
    };
  }
}
```

### 3. Bridge Pattern for Interoperability

Create adapters to allow crossover functionality when needed:

#### MCP-to-EMCP Adapter

Allow MCP servers to provide context through EMCP interface:

```typescript
export class MCPContextProvider extends BaseEMCPProvider {
  public readonly config: EMCPProviderConfig = {
    name: "mcp-bridge",
    version: "1.0.0",
    description: "Bridge to expose MCP resources as EMCP context",
    capabilities: [{
      type: "mcp-resources",
      operations: ["read", "list"],
      formats: ["json"],
    }],
  };

  constructor(private mcpClient: MCPClient) {
    super();
  }

  async provisionContext(spec: ContextSpec, context: EMCPContext): Promise<EMCPResult> {
    try {
      // Use MCP's resource listing to provide context
      const resources = await this.mcpClient.listResources();
      const content = await this.aggregateResources(resources, spec);

      return this.createSuccessResult(
        content,
        undefined,
        this.createCostInfo(Date.now() - startTime, content.length),
      );
    } catch (error) {
      return this.createErrorResult(`MCP bridge error: ${error}`);
    }
  }
}
```

#### EMCP-to-MCP Adapter

Expose EMCP operations as MCP tools:

```typescript
export class EMCPToolAdapter {
  static registerAsTools(emcpProvider: IEMCPProvider): Record<string, unknown> {
    const providerName = emcpProvider.config.name;

    return {
      [`${providerName}_list_resources`]: {
        description: `List resources from ${providerName}`,
        inputSchema: z.object({
          pattern: z.string().optional(),
        }),
        execute: async (args) => {
          const resources = await emcpProvider.listResources({
            workspaceId: "current",
            sessionId: "current",
            agentId: "emcp-adapter",
          });
          return { resources };
        },
      },

      [`${providerName}_read_resource`]: {
        description: `Read resource from ${providerName}`,
        inputSchema: z.object({
          uri: z.string(),
        }),
        execute: async (args) => {
          const result = await emcpProvider.readResource(args.uri, {
            workspaceId: "current",
            sessionId: "current",
            agentId: "emcp-adapter",
          });
          return result;
        },
      },
    };
  }
}
```

### 4. Unified Configuration Schema

Create a unified configuration approach that clearly separates concerns:

```yaml
# atlas.yml - Platform configuration
capabilities:
  # EMCP context providers
  context_providers:
    filesystem:
      type: filesystem
      base_path: ./src
      security:
        read_only: true
        allowed_directories:
          - /workspace
        denied_paths:
          - /workspace/.env
          - /workspace/secrets
      cost_tracking:
        enabled: true

    database:
      type: postgresql
      connection_env: DATABASE_URL
      security:
        ssl_required: true

  # MCP tool servers
  tool_servers:
    github:
      transport:
        type: stdio
        command: github-mcp-server
        args: ["--repo", "${GITHUB_REPO}"]
      auth:
        type: bearer
        token_env: GITHUB_TOKEN
      tools:
        allowed: [create_issue, search_code, list_prs]

    web_search:
      transport:
        type: sse
        url: https://search-mcp.example.com
      tools:
        denied: [admin_actions]

# workspace.yml - Workspace configuration
agents:
  code_analyzer:
    # Agent can use both context and tools
    context_providers:
      - filesystem # EMCP provider
    tool_servers:
      - github # MCP server
      - web_search # MCP server
```

### 5. Implementation Phases

#### Phase 1: Documentation & Clarification (Immediate)

- Document clear boundaries between EMCP and MCP
- Update CLAUDE.md with guidance on when to use each
- Create examples showing both systems in action

#### Phase 2: Unified Interface (Week 1-2)

- Implement UnifiedCapabilityManager
- Update agent base classes to use unified interface
- Add discovery methods for finding appropriate providers/servers

#### Phase 3: Bridge Adapters (Week 3-4)

- Implement MCP-to-EMCP adapter for resource-heavy MCP servers
- Implement EMCP-to-MCP adapter for exposing providers as tools
- Add configuration for enabling/disabling bridges

#### Phase 4: Enhanced Features (Week 5-6)

- Add unified cost tracking across both systems
- Implement caching layer for frequently accessed context
- Add performance monitoring and optimization

### 6. Recommended Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Atlas Agent System                     │
├─────────────────────────────────────────────────────────┤
│              Unified Capability Layer                    │
│  ┌─────────────────────────────────────────────────┐   │
│  │          UnifiedCapabilityManager               │   │
│  │  • Discovery  • Routing  • Monitoring  • Cache  │   │
│  └─────────────────────────────────────────────────┘   │
├────────────────────────┬────────────────────────────────┤
│      EMCP System       │         MCP System            │
│   (Context/Input)      │     (Tools/Actions)           │
│                        │                                │
│  ┌─────────────────┐  │  ┌──────────────────────┐    │
│  │ EMCPRegistry    │  │  │ MCPManager           │    │
│  │ • Discovery     │  │  │ • Client Management  │    │
│  │ • Routing       │  │  │ • Transport Handling │    │
│  │ • Cost Tracking │  │  │ • Tool Filtering     │    │
│  └─────────────────┘  │  └──────────────────────┘    │
│                        │                                │
│  ┌─────────────────┐  │  ┌──────────────────────┐    │
│  │ Providers:      │  │  │ Servers:             │    │
│  │ • Filesystem    │  │  │ • GitHub             │    │
│  │ • Database      │  │  │ • Web Search         │    │
│  │ • API Docs      │  │  │ • Custom Tools       │    │
│  │ • Cloud Storage │  │  │ • Terminal           │    │
│  └─────────────────┘  │  └──────────────────────┘    │
│                        │                                │
│  ┌─────────────────┐  │  ┌──────────────────────┐    │
│  │ Bridge Adapters │←→│  │ Bridge Adapters      │    │
│  └─────────────────┘  │  └──────────────────────┘    │
└────────────────────────┴────────────────────────────────┘
```

### 7. Migration Guidelines

For existing code:

1. **No Breaking Changes**: Both systems continue to work independently
2. **Gradual Adoption**: New agents use UnifiedCapabilityManager
3. **Backward Compatibility**: Existing agents continue using direct access
4. **Configuration Migration**: Tool to convert old configs to new schema

### 8. Benefits of This Approach

1. **Clear Separation**: Each system optimized for its purpose
2. **Flexibility**: Use either or both systems as needed
3. **Extensibility**: Easy to add new providers or servers
4. **Performance**: Specialized implementations for each use case
5. **Standards Compliance**: MCP remains standard-compliant
6. **Enterprise Features**: EMCP provides advanced capabilities

## Conclusion

By maintaining both EMCP and MCP as complementary systems with clear boundaries, Atlas can:

- Leverage the MCP ecosystem for tool execution
- Provide enterprise-grade context provisioning
- Offer a unified interface for agent developers
- Enable flexible integration patterns through bridges

This approach maximizes the value of both implementations while providing a clear path forward for
the Atlas platform.
