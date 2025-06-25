# Atlas Architectural Foundation

## WTF is Atlas?

Atlas is fundamentally a **Distributed Multi-Agent Runtime** - think of it as an operating system specifically designed for AI agents. But what does that actually mean?

### The Core Problem Atlas Solves

The AI agent ecosystem is fragmenting across multiple competing protocols (MCP, ACP, REST, GraphQL, gRPC) that are unstable and inconsistently implemented. Organizations need to build sophisticated multi-agent workflows but can't afford to rebuild every time a protocol changes or a new one emerges.

### Atlas as Multi-Agent Runtime

Atlas provides the foundational infrastructure that AI agents need to operate at scale:

**Process Management**: Spawns, schedules, and manages agent lifecycles across distributed infrastructure

**Memory Management**: Provides hierarchical, semantic memory systems (workspace → session → agent) with episodic, procedural, and semantic memory types

**Inter-Process Communication**: Enables agent-to-agent communication via multiple protocols, with protocol translation and abstraction

**Resource Management**: Manages compute, LLM tokens, rate limits, costs, and model capabilities

**Security & Permissions**: RBAC, audit trails, isolation between agents and workspaces

**Distributed Execution**: Coordinates agents across multiple workspaces, nodes, and cloud providers

**Service Discovery**: Agents can dynamically discover and compose other agents and services

**Protocol Abstraction**: Multiple ways to access the same underlying capabilities - MCP, ACP, REST, etc.

### Why "Operating System" is Accurate

Atlas exhibits all the characteristics of an operating system, but specialized for AI agents:

- **Process Model**: Agents are processes with lifecycles, isolation, and communication channels
- **Memory Hierarchy**: Working memory, long-term memory, shared memory with semantic understanding
- **System Calls**: MCP/ACP/REST are like different syscall interfaces to the same kernel
- **Device Drivers**: Different agent types (LLM, remote, deterministic) abstract underlying compute
- **Scheduler**: Atlas schedules agent execution, manages priorities and dependencies
- **Security Model**: Comprehensive permissions, principals, and audit trails
- **File System**: Context and memory management with semantic search and retrieval

### What Makes Atlas AI-Native

Unlike general-purpose distributed systems, Atlas is designed specifically for AI agent semantics:

- **LLM-aware**: Understands tokens, context windows, model capabilities, and costs
- **Reasoning-centric**: Built around agents that think, plan, make decisions, and learn
- **Human-in-the-loop**: Native support for approval workflows, oversight, and collaboration
- **Cost-aware**: Token tracking, model costs, resource optimization across providers
- **Memory-semantic**: Not just data storage, but episodic, semantic, and procedural memory
- **Prompt-native**: Configuration through natural language, not just parameters
- **Planning-aware**: Supports complex reasoning patterns like chain-of-thought, ReAct, HTN

### The Protocol Abstraction Layer

Atlas accepts the fundamental reality that:
1. **Multiple protocols will coexist** (MCP, ACP, REST, GraphQL, gRPC, WebSockets)
2. **Protocols are unstable** and evolve rapidly
3. **Implementation quality varies** across the ecosystem

Atlas provides stability by exposing consistent capabilities regardless of underlying protocol:

```yaml
# Same Atlas job, multiple access methods
server:
  mcp: {enabled: true}     # Model Context Protocol
  acp: {enabled: true}     # Agent Communication Protocol  
  rest: {enabled: true}    # Traditional REST APIs
  graphql: {enabled: false} # Future: GraphQL introspection
  grpc: {enabled: false}   # Future: High-performance gRPC
```

### Alternative Framings Considered

**"Universal Protocol Adapter"**: Too reductive - misses the runtime, memory, and orchestration aspects

**"Agent Mesh"**: Captures the distributed, interconnected nature but misses the foundational OS-like capabilities

**"AI Agent Infrastructure"**: Accurate but generic - doesn't convey the runtime semantics

**"Multi-Agent System Platform"**: Academic precision but lacks the systems architecture implications

### The Matryoshka Architecture

Atlas enables recursive agent composition - agents can discover, orchestrate, and contain other agents through standard protocols. This creates a "matryoshka doll" architecture where:

```
External Agent (Claude Desktop)
  ↓ MCP Protocol
Atlas WorkspaceSupervisor 
  ↓ Internal Orchestration
Atlas LLM Agent (with MCP tools)
  ↓ MCP Protocol
Other Atlas Workspaces OR External Services
```

Every layer uses standard protocols, enabling universal debugging, monitoring, and composition.

---

## Core Architecture: Everything is a Workspace

### Fundamental Hierarchy

Atlas follows a clean hierarchical model:

```
Atlas (Platform)
├── Workspace (Isolated environment)
│   ├── Job (Pre-configured workflow)
│   │   ├── Session (Execution instance) 
│   │   │   ├── Agent (Individual executor)
```

**Key Innovation**: `atlas.yml` is not separate platform configuration - it **IS** a workspace. Specifically, it's the **default workspace with global management capabilities**.

This means:
- **Unified configuration model**: Same structure for platform and workspaces
- **No special cases**: Everything uses workspace semantics
- **Natural hierarchy**: Global workspace can manage child workspaces
- **Clean MCP servers**: Both platform and workspaces expose MCP servers using identical patterns

### Multi-Level MCP Server Architecture

Because everything is a workspace, we get natural **hierarchical MCP servers**:

**Platform MCP Server** (`atlas.yml` workspace):
```typescript
// Global management capabilities
atlas_create_workspace(config)
atlas_list_workspaces()
atlas_orchestrate_cross_workspace(plan)

// Plus whatever jobs the platform workspace defines
atlas_analyze_global_metrics()
atlas_audit_all_workspaces()
```

**Workspace MCP Server** (individual `workspace.yml`):
```typescript
// Workspace-specific capabilities
atlas_trigger_job(jobName, payload)
atlas_get_job_status(sessionId)
atlas_list_available_jobs()

// Jobs defined in this workspace
atlas_telephone_game(message)
atlas_analyze_codebase(repo)
```

**Job Discovery Control**: Each workspace controls what jobs are discoverable via MCP:

```yaml
server:
  mcp:
    enabled: true
    discoverable_jobs: ["analyze-code", "generate-report"]  # Only these exposed
```

### Configuration Architecture

#### Two-Level Tool Configuration

```yaml
# atlas.yml - Platform workspace with governance
tools:
  mcp:
    client_config:
      timeout: 30000
      retry_policy: {max_attempts: 3}
      connection_pool: {max_connections: 10}
    
    servers:
      # MCP servers the platform uses
      global-filesystem-mcp:
        command: "filesystem-mcp"
        args: ["/"]
      
    policies:
      # What child workspaces are allowed to use
      type: "allowlist"
      allowed:
        - id: "filesystem-mcp"
          restrictions:
            args: ["/workspace/*"]  # Restrict to workspace paths
        - id: "github-mcp"
        - id: "slack-mcp"
      denied:
        - "shell-mcp"
        - "unrestricted-*"

# Child workspace inherits restrictions
# workspace.yml
tools:
  mcp:
    servers:
      filesystem-mcp:        # ✅ Allowed by platform policy
        command: "filesystem-mcp"
        args: ["/workspace"]
      github-mcp:           # ✅ Allowed by platform policy
        command: "github-mcp"
        auth: {credential_id: "workspace-github"}
      # shell-mcp would be rejected by platform validation
```

#### Semantic Clarity

The configuration structure maintains semantic clarity:

- **`tools.mcp.client_config`**: How Atlas behaves as an MCP client (timeouts, retries)
- **`tools.mcp.servers`**: What MCP servers this workspace connects to as a client
- **`tools.mcp.policies`**: Governance rules for child workspaces (platform only)
- **`server.mcp`**: How this workspace exposes itself as an MCP server

### User Experience & Discovery

**Configuration Discoverability**: Users cannot see what MCP tools are globally available just by reading their `workspace.yml`. They must either:
1. Read `atlas.yml` platform configuration
2. Use trial-and-error validation
3. Use the planned conversational interface

**Design Decision**: This is acceptable because:
- **Separation of concerns**: Users focus on workspace config, platform admins handle governance
- **Conversational interface**: Will provide runtime discovery and validation
- **Future LSP support**: Will enable IDE-based discovery and validation

### Benefits of the Unified Model

1. **Architectural Consistency**: One configuration pattern, one execution model, one security model
2. **Natural Governance**: Platform workspace controls child workspace capabilities through standard tool policies
3. **Recursive Composition**: Workspaces can orchestrate other workspaces using the same MCP interface
4. **Simplified Implementation**: No special platform-vs-workspace code paths
5. **Clear Mental Model**: "Everything is a workspace" is easy to understand and reason about

### Next Steps

The foundation is now established for:
- **Server configuration**: How workspaces expose themselves via different protocols
- **Cross-workspace orchestration**: Workspaces discovering and calling each other
- **Enterprise governance**: Platform control over child workspace capabilities
- **Protocol evolution**: Adding new protocols without breaking existing configurations

---

## Protocol & Addressing Architecture

### Web-Native Protocol Design

Atlas uses **HTTPS APIs** instead of custom protocols for distributed addressing:

**Local Atlas:**
```
https://localhost:8080/api/workspace.create
https://localhost:8080/api/job.trigger
```

**Distributed Atlas:**
```
https://company.atlas.tempest.cloud/api/workspace.create
https://partner.company.com/atlas/api/job.trigger
```

This provides:
- **Web-native security**: CORS, same-origin policy, standard certificates
- **Universal tooling**: Works with curl, browser dev tools, standard HTTP clients
- **No browser warnings**: HTTPS is trusted everywhere
- **Standard authentication**: Bearer tokens, OAuth, standard headers

### MCP Tool Naming Convention

Following Eric's CLI **noun-verb structure**, MCP tools use consistent naming:

```typescript
// Correct: noun-verb pattern
workspace.create
job.trigger
session.list
agent.describe

// Wrong: verb-noun pattern  
create.workspace
trigger.job
```

### Remote Management System

Atlas uses a **git-like remote system** for managing multiple Atlas instances:

**Remote Configuration:**
```bash
# Add Atlas instances as remotes
atlas remote add company https://atlas.company.com
atlas remote add partner https://partner.atlas.tempest.cloud  
atlas remote add local http://localhost:8080

# Set default remote
atlas remote use company

# List configured remotes
atlas remote list
```

**Command Usage:**
```bash
# Use default remote (stateful)
atlas remote use company
atlas workspace create my-project  # Uses company remote

# Per-command override
atlas workspace create --remote partner
atlas job trigger analyze-code --remote local
```

**Cross-Remote Orchestration:**
```yaml
# workspace.yml - Workspaces can orchestrate across Atlas instances
tools:
  mcp:
    servers:
      partner-analytics:
        transport: {type: "atlas-proxy", remote: "partner", workspace: "analytics"}
      local-testing:
        transport: {type: "atlas-proxy", remote: "local", workspace: "test-env"}
```

## Atlas Deployment Models

### Local Atlas
**Use Case**: Individual developers, personal projects, learning

**Installation & Usage:**
```bash
deno install atlas
atlas workspace create my-project
```

**Characteristics:**
- **Single user**: No multi-tenancy
- **Local storage**: Files, SQLite, in-memory
- **No authentication**: Trusted local environment  
- **Simple networking**: localhost only
- **Resource limits**: Local machine constraints
- **Security model**: Process isolation, file permissions

### Self-Hosted Atlas
**Use Case**: Teams, organizations, on-premises requirements

**Deployment:**
```bash
docker run atlas-server --config /etc/atlas/atlas.yml
kubectl apply -f atlas-deployment.yml
```

**Usage:**
```bash
atlas remote add company https://atlas.company.com
atlas workspace create --remote company
```

**Characteristics:**
- **Multi-tenant**: Multiple teams/projects
- **Distributed storage**: PostgreSQL, Redis, S3
- **Enterprise auth**: RBAC, SSO, audit logs
- **Network security**: TLS, firewalls, VPN
- **Scalable**: Kubernetes, load balancing
- **Self-managed**: You handle ops, updates, security

### Tempest Atlas Managed Service
**Use Case**: Organizations wanting Atlas without operational overhead

**Onboarding:**
```bash
curl -X POST https://api.tempest.cloud/v1/atlas/instances \
  -H "Authorization: Bearer $TEMPEST_TOKEN" \
  -d '{"org": "company", "region": "us-east-1"}'
```

**Usage:**
```bash
atlas remote add managed https://company.atlas.tempest.cloud
atlas workspace create --remote managed
```

**Characteristics:**
- **Fully managed**: Tempest handles ops, updates, scaling
- **Enterprise-grade**: SLA, support, compliance (SOC2, HIPAA)
- **Global deployment**: Multi-region, edge locations
- **Advanced features**: Cross-organization federation, marketplace
- **Integrated ecosystem**: Tempest AI services, pre-built agents
- **Usage-based pricing**: Pay for what you use

### Configuration Inheritance

```yaml
# Local Atlas (atlas.yml)
workspace:
  id: "local-default"
server:
  mcp: {enabled: true}
  
# Self-Hosted Atlas (atlas.yml)  
workspace:
  id: "company-platform"
server:
  mcp: {enabled: true}
  auth: {provider: "oauth2"}
tools:
  mcp:
    policies:
      type: "allowlist"
      allowed: ["filesystem-mcp", "github-mcp"]

# Tempest Managed (atlas.yml)
workspace:
  id: "tempest-managed-platform"  
server:
  mcp: {enabled: true}
  auth: {provider: "tempest-sso"}
tools:
  mcp:
    policies:
      type: "marketplace"
      tempest_services: ["memory-service", "analytics-service"]
```

### Migration Path
1. **Start Local**: Learn, prototype, develop
2. **Scale Self-Hosted**: Team adoption, custom requirements  
3. **Upgrade Managed**: Enterprise scale, reduced ops burden

Each deployment model uses the same APIs and configuration patterns - only the remote targets change.

## Benefits of the Unified Remote Model

- **Distributed collaboration**: Work with multiple Atlas instances seamlessly
- **Federation**: Workspaces can orchestrate across organizational boundaries
- **Familiar pattern**: Follows git remote conventions developers know
- **Future-ready**: Reserves "profile" for user-specific configuration later
- **Flexible**: Both stateful (current remote) and per-command usage
- **Scalable**: From local development to multi-organizational federation

---

## MCP Capability Architecture

### Platform vs Workspace Capabilities

Atlas distinguishes between **platform capabilities** (Atlas native functionality) and **workspace capabilities** (user-defined jobs, signals, agents). This separation provides clear security boundaries and discovery semantics.

### Platform Capabilities (Always Available)

Platform capabilities operate on the Atlas instance itself and are always accessible:

**Workspace Management:**
```typescript
workspace.list()                    // List all workspaces
workspace.describe(workspaceId)     // Get workspace details
workspace.create(config)            // ✅ Create new workspaces
workspace.delete(workspaceId)       // ✅ Delete workspaces
```

### Workspace Capabilities (Require Workspace Context)

Workspace capabilities operate on user-defined resources within a specific workspace:

**Jobs (User-Defined Workflows):**
```typescript
workspace.jobs.list(workspaceId)                          // List jobs defined in workspace.yml
workspace.jobs.describe(workspaceId, jobName)             // Get job configuration and metadata  
workspace.jobs.trigger(workspaceId, jobName, payload)     // Execute a job
// ❌ No workspace.jobs.create() - jobs are configuration-driven only
```

**Signals (User-Defined Triggers):**
```typescript
workspace.signals.list(workspaceId)                       // List signals defined in workspace.yml
workspace.signals.describe(workspaceId, signalName)       // Get signal configuration
workspace.signals.trigger(workspaceId, signalName, payload) // Trigger a signal
// ❌ No workspace.signals.create() - signals are configuration-driven only
```

**Agents (User-Defined Executors):**
```typescript
workspace.agents.list(workspaceId)                        // List agents defined in workspace.yml
workspace.agents.describe(workspaceId, agentId)           // Get agent capabilities and metadata
// ❌ No workspace.agents.create() - agents are configuration-driven only
// ❌ No workspace.agents.execute() - agents only execute through jobs
```

**Sessions (Runtime Execution Instances):**
```typescript
workspace.sessions.list(workspaceId)                      // List active/completed sessions
workspace.sessions.describe(workspaceId, sessionId)       // Get session status and results
workspace.sessions.cancel(workspaceId, sessionId)         // Cancel running session
// ❌ No workspace.sessions.create() - sessions created by triggering jobs
```

### Design Principles

**Configuration-Driven Approach**: Jobs, signals, and agents are defined in `workspace.yml` configuration files, not created dynamically via MCP calls. This ensures:
- **Version control**: All definitions are tracked in configuration
- **Review process**: Changes go through standard code review
- **Consistency**: No runtime drift from intended configuration
- **Security**: Prevents dynamic creation of potentially unsafe workflows

**Rich Introspection**: Every resource type supports `list()` and `describe()` operations to enable:
- **Service discovery**: External systems can discover available capabilities
- **Documentation**: Detailed metadata about what each resource does
- **Debugging**: Full visibility into configuration and state

**Clear Scope Boundaries**: Platform operations vs workspace operations have different:
- **Permission models**: Platform access vs workspace access
- **Discovery semantics**: Global resources vs workspace-scoped resources  
- **Security boundaries**: Cross-workspace isolation maintained

### Capability Discovery Flow

External MCP clients follow a natural discovery pattern:

```typescript
// 1. Discover available workspaces
const workspaces = await mcp.call("workspace.list");

// 2. Explore a specific workspace
const jobs = await mcp.call("workspace.jobs.list", {workspaceId: "dev-team"});
const signals = await mcp.call("workspace.signals.list", {workspaceId: "dev-team"});

// 3. Get detailed information
const jobDetails = await mcp.call("workspace.jobs.describe", {
  workspaceId: "dev-team", 
  jobName: "analyze-codebase"
});

// 4. Execute capabilities
const session = await mcp.call("workspace.jobs.trigger", {
  workspaceId: "dev-team",
  jobName: "analyze-codebase", 
  payload: {repo: "atlas"}
});
```

This provides a **self-documenting API** where external systems can discover and use Atlas capabilities without prior knowledge of specific workspace configurations.

---

## Server Configuration Architecture

### Platform Server Configuration (atlas.yml)

The Atlas platform workspace configures the **global MCP server** that exposes platform capabilities:

```yaml
# atlas.yml - Platform workspace configuration
workspace:
  id: "atlas-platform"
  name: "Atlas Platform"

# Platform MCP server configuration
server:
  mcp:
    enabled: true
    transport: {type: "stdio"}
    discoverable:
      # Platform capabilities exposed via MCP
      capabilities:
        - "workspace.list"
        - "workspace.describe" 
        - "workspace.create"
        - "workspace.delete"
      
      # Platform-specific jobs (if any defined in this workspace)
      jobs: []  # Platform workspace typically has no user-defined jobs
    
    # Security and access control for platform server
    auth:
      required: true
      providers: ["oauth2", "api-key"]
    
    rate_limits:
      requests_per_hour: 1000
      burst_limit: 100
    
    cors:
      allowed_origins: ["*"]  # Or specific domains
      allowed_methods: ["POST"]

# Platform tools and policies (as defined earlier)
tools:
  mcp:
    client_config: {...}
    servers: {...}
    policies: {...}
```

### Workspace Server Configuration (workspace.yml)

Each workspace configures its own **workspace MCP server** that exposes workspace-specific capabilities:

```yaml
# workspace.yml - Individual workspace configuration
workspace:
  id: "dev-team"
  name: "Development Team Workspace"

# Workspace MCP server configuration
server:
  mcp:
    enabled: true
    transport: {type: "stdio"}
    discoverable:
      # Workspace capabilities always available
      capabilities:
        - "workspace.jobs.list"
        - "workspace.jobs.describe"
        - "workspace.jobs.trigger"
        - "workspace.signals.list"
        - "workspace.signals.describe" 
        - "workspace.signals.trigger"
        - "workspace.agents.list"
        - "workspace.agents.describe"
        - "workspace.sessions.list"
        - "workspace.sessions.describe"
        - "workspace.sessions.cancel"
      
      # User-defined jobs exposed via MCP (subset of all jobs)
      jobs:
        - "analyze-codebase"
        - "generate-report"
        - "public-*"          # Glob pattern: all jobs starting with "public-"
        - "*-api"             # Glob pattern: all jobs ending with "-api"
        # "internal-cleanup" not listed = not discoverable via MCP
    
    # Workspace-level security
    auth:
      required: false  # Could inherit from platform or override
      providers: ["workspace-token"]
    
    rate_limits:
      requests_per_hour: 500
      concurrent_sessions: 5

# Jobs, signals, agents defined in workspace
jobs:
  analyze-codebase: {...}
  generate-report: {...}
  internal-cleanup: {...}  # Not in discoverable.jobs = internal only

signals:
  webhook-handler: {...}
  scheduled-task: {...}

agents:
  code-analyzer: {...}
  report-generator: {...}
```

### Multi-Protocol Server Support

Both platform and workspace servers can support multiple protocols:

```yaml
# atlas.yml or workspace.yml
server:
  mcp:
    enabled: true
    discoverable: {...}
  
  acp:
    enabled: true
    discoverable_agents: ["*"]  # Or specific agent list
  
  rest:
    enabled: true
    prefix: "/api/v1"
    swagger: true
  
  graphql:
    enabled: false  # Future expansion
```

### Server Hierarchy and Discovery

**Two-Level Server Architecture:**

1. **Platform Server** (`atlas.yml`):
   - **Address**: `https://company.atlas.tempest.cloud/api/`
   - **Capabilities**: Workspace management (create, list, delete, describe)
   - **Scope**: Cross-workspace operations
   - **Authentication**: Enterprise SSO, API keys

2. **Workspace Servers** (`workspace.yml`):
   - **Address**: `https://company.atlas.tempest.cloud/workspace/{workspaceId}/api/`
   - **Capabilities**: Workspace-specific operations (jobs, signals, agents, sessions)
   - **Scope**: Single workspace operations
   - **Authentication**: Workspace tokens, inherited from platform

### Client Connection Patterns

**Connecting to Platform Server:**
```bash
# Configure remote pointing to platform
atlas remote add company https://company.atlas.tempest.cloud

# Platform operations
atlas workspace list --remote company
atlas workspace create my-new-workspace --remote company
```

**Connecting to Workspace Server:**
```bash
# Configure remote pointing to specific workspace
atlas remote add dev-workspace https://company.atlas.tempest.cloud/workspace/dev-team

# Workspace operations
atlas workspace jobs list --remote dev-workspace
atlas workspace jobs trigger analyze-codebase --remote dev-workspace
```

**MCP Client Configuration:**
```json
{
  "servers": {
    "atlas-platform": {
      "command": "atlas-mcp-client",
      "args": ["--target", "https://company.atlas.tempest.cloud"]
    },
    "dev-workspace": {
      "command": "atlas-mcp-client", 
      "args": ["--target", "https://company.atlas.tempest.cloud/workspace/dev-team"]
    }
  }
}
```

### Environment Variable Configuration

Atlas provides flexible credential management for MCP servers through comprehensive environment configuration:

```yaml
# workspace.yml
tools:
  mcp:
    servers:
      github-mcp:
        command: "github-mcp-server"
        env:
          # Environment variable reference
          GITHUB_PERSONAL_ACCESS_TOKEN:
            from_env: "GITHUB_TOKEN"
            required: true
          
          # Literal value
          DEBUG_MODE:
            value: "true"
          
          # Environment variable with default fallback
          API_BASE_URL:
            from_env: "GITHUB_API_URL"
            default: "https://api.github.com"
          
          # Read from .env file (Docker-style)
          DATABASE_URL:
            from_env_file: ".env"
            key: "DATABASE_URL"
            required: true
          
          # File-based credential (raw file contents)
          SECRET_KEY:
            from_file: "/run/secrets/secret_key"
          
          # Multiple fallback sources
          OPENAI_API_KEY:
            from_env_file: ".env"           # Try .env file first
            key: "OPENAI_API_KEY"
            from_env: "OPENAI_API_KEY"      # Then environment
            from_file: "~/.openai/key"      # Then file
            default: ""                     # Finally default
            required: false
```

**Configuration Options:**
- **`value`**: Literal string value
- **`from_env`**: Reference to environment variable
- **`from_env_file`**: Key from `.env` style file with `KEY=value` pairs
- **`from_file`**: Read raw file contents (Docker secrets, credential files)
- **`default`**: Fallback value if primary source fails
- **`required`**: Validation - fail if not provided and required

**Evaluation Order:**
1. `from_env_file` (if specified)
2. `from_env` (if specified or fallback)
3. `from_file` (if specified or fallback)
4. `default` (if specified)
5. Fail if `required: true` and no value found

**Use Cases:**
- **Environment variables**: Standard `GITHUB_TOKEN=xxx` pattern
- **Docker secrets**: Files mounted at `/run/secrets/`
- **Credential files**: `~/.atlas/credentials` or similar
- **Docker compose**: `.env` files with multiple key-value pairs
- **CI/CD**: Environment files in build systems

### Configuration Inheritance and Overrides

**Platform Defaults:**
```yaml
# atlas.yml - Set platform-wide defaults
server:
  defaults:
    mcp:
      auth: {required: true, providers: ["oauth2"]}
      rate_limits: {requests_per_hour: 1000}
      cors: {allowed_origins: ["*.company.com"]}
```

**Workspace Overrides:**
```yaml
# workspace.yml - Can override platform defaults
server:
  mcp:
    auth: {required: false}  # Override: no auth required for this workspace
    rate_limits: {requests_per_hour: 2000}  # Override: higher limits
    # cors inherits from platform defaults
```

### Globbing Support for Discovery

Atlas supports **glob patterns** for flexible discovery configuration while maintaining security:

**Job Discovery Patterns:**
```yaml
server:
  mcp:
    discoverable:
      jobs:
        - "public-*"         # All jobs starting with "public-"
        - "*-api"            # All jobs ending with "-api"
        - "analyze-codebase" # Explicit job names still supported
```

**Capability Filtering:**
```yaml
server:
  mcp:
    discoverable:
      capabilities:
        - "workspace.jobs.*"    # All job-related operations
        - "workspace.*.list"    # All list operations
        - "workspace.sessions.describe" # Explicit capabilities still supported
```

**Security Boundaries:**
- **✅ Discovery patterns**: Safe for controlling what's visible/discoverable
- **❌ Execution patterns**: NO glob support for operations like `trigger()`, `delete()`, etc.
- **Workspace-scoped**: Patterns only apply within individual workspaces
- **No cross-workspace globs**: All operations require explicit workspace IDs

**Benefits:**
- **Flexible exposure control**: Group jobs/capabilities by naming convention
- **Future-proof**: New jobs matching patterns automatically discoverable
- **Reduced configuration**: Less maintenance when adding new jobs
- **Security-first**: Patterns only control visibility, not execution

### Benefits of Two-Level Server Architecture

1. **Clear Separation**: Platform operations vs workspace operations
2. **Security Isolation**: Different authentication and permissions per level
3. **Scalability**: Workspace servers can be distributed/federated
4. **Discoverability**: Platform server provides workspace discovery, workspace servers provide capability discovery
5. **Flexibility**: Each workspace can customize its server configuration with glob patterns
6. **Standard Patterns**: Both levels use identical configuration structure

---

## Federation & Cross-Workspace Architecture

### Component Access Patterns

Atlas enables recursive composition where workspaces, jobs, and agents can access each other's capabilities through well-defined patterns:

#### 1. Workspace → Platform Capabilities
Workspaces access Atlas platform capabilities via MCP proxy configuration:

```yaml
# workspace.yml
tools:
  mcp:
    servers:
      atlas-platform:
        transport: {type: "atlas-proxy", target: "platform"}
        # Provides access to:
        # - workspace.create(), workspace.list(), workspace.delete()
```

#### 2. Job → Other Jobs (Same Workspace)
Jobs orchestrate other jobs within the same workspace using built-in capabilities:

```yaml
# workspace.yml
jobs:
  orchestrator-job:
    execution:
      agents:
        - id: "coordinator-agent"
          tools:
            - "workspace.jobs.trigger"  # Built-in workspace capability
            - "workspace.jobs.list"
    
  target-job:
    # Can be triggered by orchestrator-job
```

#### 3. Job → Other Workspaces
Jobs access other workspaces through federation and MCP proxy:

```yaml
# workspace.yml - "dev-team" workspace
tools:
  mcp:
    servers:
      qa-workspace:
        transport: {type: "atlas-proxy", workspace: "qa-team"}
        # Access controlled by federation.sharing policies
      
jobs:
  deploy-with-testing:
    execution:
      agents:
        - id: "deploy-agent"
          # Can trigger jobs in qa-workspace if federation allows
```

### Built-in Workspace Capabilities

#### Ambient Availability vs Tool Assignment

Workspace capabilities are **ambiently available** in the execution environment but **not automatically assigned** to agents:

```typescript
// Always available in workspace execution environment
interface WorkspaceExecutionEnvironment {
  workspace: {
    jobs: { trigger, list, describe },
    sessions: { list, describe, cancel },
    memory: { recall, store },
    signals: { list, trigger }
  }
}

// Agents only get explicitly granted capabilities
interface AgentToolset {
  // Filtered based on job configuration
}
```

#### Job-Level Tool Assignment

```yaml
# workspace.yml
jobs:
  simple-transform:
    execution:
      agents:
        - id: "transform-agent"
          # Gets NO workspace tools by default
          
  orchestrator-job:
    execution:  
      agents:
        - id: "coordinator-agent"
          tools:
            - "workspace.jobs.trigger"     # Explicitly granted
            - "workspace.jobs.list"
            - "workspace.sessions.describe"
            # Does NOT get workspace.memory.*, etc.
```

#### Agent Default Tools

```yaml
# workspace.yml
agents:
  coordinator-agent:
    type: "llm"
    default_tools:
      - "workspace.jobs.*"      # All job operations
      - "workspace.sessions.*"  # All session operations
      
  simple-agent:
    type: "llm"  
    default_tools: []  # No default workspace tools - security by default
```

### Federation Configuration

#### Cross-Workspace Sharing

The platform workspace controls cross-workspace access through federation policies:

```yaml
# atlas.yml - Platform workspace
federation:
  sharing:
    # Simple: workspace-level scopes
    dev-team:
      workspaces: ["qa-team", "staging"]
      scopes: "standard"
    
    qa-team:
      workspaces: "production"  # Single workspace supported
      scopes: "deploy_only"
    
    # Complex: per-workspace grants with overrides
    analytics:
      grants:
        - workspace: "dev-team"
          scopes: "read_only"
        - workspace: "qa-team"
          scopes: ["jobs.trigger", "sessions.list"]  # Inline override

  scope_sets:
    standard: ["jobs.list", "jobs.describe", "jobs.trigger", "sessions.list"]
    read_only: ["jobs.list", "jobs.describe", "sessions.list"]
    deploy_only: ["jobs.trigger"]
    admin: ["jobs.*", "sessions.*", "workspace.describe"]
```

#### Scope System (OAuth-Aligned)

Atlas uses OAuth-style scopes for granular access control:

**Scope Patterns:**
- **Specific**: `jobs.trigger`, `sessions.list`
- **Wildcard**: `jobs.*`, `sessions.*`
- **Predefined Sets**: Reference common combinations via `scope_sets`
- **Inline Overrides**: Define scopes directly in sharing configuration

**Security Model:**
- **Default deny**: No cross-workspace access unless explicitly configured
- **Workspace-scoped**: All operations require explicit workspace context
- **Capability-based**: Fine-grained control over what operations are allowed

### Local vs Remote Performance

#### Local Operations (Same Atlas Instance)
- **Direct function calls**: No MCP overhead for workspace-internal operations
- **Shared memory space**: Faster execution, lower latency
- **Built-in capabilities**: Available in agent execution context

#### Remote Operations (Different Atlas Instances)
- **MCP proxy required**: Network calls through configured remotes
- **Authentication needed**: Standard HTTP/OAuth flows
- **Explicit configuration**: Must configure in `tools.mcp.servers`

```yaml
# Local job orchestration
jobs:
  local-orchestrator:
    execution:
      agents:
        - id: "coordinator"
          tools:
            - "workspace.jobs.trigger"  # Direct, fast

# Remote job orchestration  
jobs:
  remote-orchestrator:
    execution:
      agents:
        - id: "coordinator"
          # Uses partner_workspace MCP server (network call)
```

### Discovery and Introspection

Workspaces can discover each other's capabilities through platform APIs:

```typescript
// Available to agents with appropriate tools
const workspaces = await workspace.platform.list();
const jobs = await workspace.jobs.list(targetWorkspaceId);
const jobDetails = await workspace.jobs.describe(targetWorkspaceId, jobName);

// Execute with federation permission checks
const session = await workspace.jobs.trigger(targetWorkspaceId, jobName, payload);
```

### Security and Isolation

**Workspace Boundaries:**
- Each workspace operates in isolated context
- Cross-workspace access requires explicit federation configuration
- All operations are audited and attributed

**Agent Capabilities:**
- Agents start with zero workspace tools
- Must be explicitly granted capabilities per job
- Cannot access capabilities outside their granted scope

**Federation Controls:**
- Platform workspace controls all cross-workspace sharing
- Granular scope-based permissions
- Support for both simple and complex sharing patterns

### Benefits of Federation Architecture

1. **Recursive Composition**: Workspaces can orchestrate other workspaces seamlessly
2. **Security by Default**: No access unless explicitly configured
3. **Performance Optimization**: Local operations bypass network overhead
4. **OAuth-Aligned**: Familiar scope-based permission model
5. **Flexible Configuration**: Simple patterns for common cases, complex patterns for edge cases
6. **Enterprise-Ready**: Full audit trail and granular access controls

---

## Implementation Roadmap

*[Continue with implementation planning...]*
