# MCP Registry Implementation Plan

## Overview

This plan outlines the implementation of an MCP Registry system that enhances Atlas's workspace creation flow by providing intelligent MCP tool discovery. The registry implements a three-tier discovery strategy: built-in agents + user agents → static approved list → web research fallback.

## Current State Analysis

### Existing Architecture
- **Workspace Creation Flow**: Atlas conversation agent uses workspace creation tools to build workspaces
- **MCP Integration**: `GlobalMCPServerPool`, `MCPServerRegistry`, and workspace-level MCP configuration
- **Agent Registry**: Supports bundled, system, SDK, and YAML agents via `AgentRegistry`
- **Static MCP Guide**: Comprehensive list of approved MCP servers in `mcp-servers-guide.md`

### Current Limitations
- No programmatic MCP server discovery during workspace creation
- Manual selection of MCP tools requires user knowledge of available options
- No integration between agent capabilities and MCP tool recommendations
- Static documentation that doesn't assist in automated workspace generation

## Proposed Solution: Multi-Tier MCP Registry

### Architecture Overview

```
Atlas Conversation Agent
           ↓
    Workspace Creation Flow
           ↓
      MCP Registry
     (3-tier discovery)
           ↓
    Intelligent Tool Selection
           ↓
    Generated Workspace Config
```

### Tier 1: Built-in & User Agent Discovery
**Purpose**: Leverage existing agent ecosystem for MCP recommendations
**Data Sources**:
- `AgentRegistry` (bundled, system, SDK agents)
- User-created agents from workspace directories

**Implementation**:
- Query `AgentRegistry` for agents matching user intent
- Extract MCP server configurations from agent definitions
- Analyze agent tool usage patterns
- Return recommended MCP servers with usage context

### Tier 2: Static Approved Registry
**Purpose**: Curated list of production-ready MCP servers
**Data Source**: Enhanced version of `mcp-servers-guide.md`

**Implementation**:
- Parse and index static MCP registry
- Enable semantic search over server descriptions and use cases
- Provide configuration templates for each server
- Include security and reliability ratings

### Tier 3: Web Research Fallback
**Purpose**: Discover new or specialized MCP tools via web search
**Data Sources**:
- GitHub repositories
- NPM registry
- Official MCP server listings
- Community documentation

**Implementation**:
- Intelligent web search for MCP servers matching requirements
- Parse repository metadata and documentation
- Validate server compatibility and security
- Generate configuration snippets for discovered servers

## Detailed Implementation

### 1. Core MCP Registry Service

**Location**: `packages/core/src/mcp-registry/`

```typescript
interface MCPServerMetadata {
  id: string;
  name: string;
  description: string;
  category: MCPCategory;
  source: MCPSource;
  transportTypes: Array<'stdio' | 'sse'>;
  tools: ToolMetadata[];
  useCases: string[];
  securityRating: SecurityRating;
  configTemplate: MCPServerConfig;
  documentation?: string;
  repository?: string;
}

interface MCPDiscoveryRequest {
  intent: string; // User's natural language request
  domain?: string; // Category filter
}

interface MCPDiscoveryResult {
  server: MCPServerMetadata;
  reasoning: string;
}

class MCPRegistry {
  async discoverBestMCPServer(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult | null>
  async getServerMetadata(serverId: string): Promise<MCPServerMetadata | null>
  async validateServerConfig(config: MCPServerConfig): Promise<ValidationResult>
}
```

### 2. Three-Tier Discovery Implementation

#### Tier 1: Agent-Based Discovery
**File**: `packages/core/src/mcp-registry/agent-discovery.ts`

```typescript
class AgentBasedMCPDiscovery {
  constructor(private agentRegistry: AgentRegistry) {}

  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    // 1. Query AgentRegistry for relevant agents
    const agents = await this.agentRegistry.searchAgents(request.intent);

    // 2. Extract MCP server configurations from agent definitions
    const mcpConfigs = this.extractMCPConfigurations(agents);

    // 3. Analyze usage patterns and score candidates
    const candidates = this.scoreAgentBasedCandidates(mcpConfigs, request);

    return candidates;
  }

  private extractMCPConfigurations(agents: AgentMetadata[]): MCPServerConfig[] {
    // Parse agent configurations for MCP server usage
    // Extract from YAML agent files, SDK agent MCP dependencies
  }

  private scoreAgentBasedCandidates(configs: MCPServerConfig[], request: MCPDiscoveryRequest): MCPDiscoveryResult[] {
    // Score configurations based on:
    // - Agent success rates with specific MCP servers
    // - Tool usage frequency
    // - Compatibility with request intent
    // Return scored candidates for final ranking
  }
}
```

#### Tier 2: Static Registry Discovery
**File**: `packages/core/src/mcp-registry/static-discovery.ts`

```typescript
class StaticMCPDiscovery {
  private static registry: MCPServerMetadata[] = [];
  private static initialized = false;

  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    await this.ensureInitialized();

    // 1. Semantic search over server descriptions
    const candidates = this.semanticSearch(request.intent);

    // 2. Filter by capabilities and domain
    const filtered = this.filterByCriteria(candidates, request);

    // 3. Score by relevance and reliability
    return this.scoreStaticCandidates(filtered, request);
  }

  private async loadStaticRegistry(): Promise<void> {
    // Parse enhanced mcp-servers-guide.md
    // Index server metadata for efficient search
    // Pre-compute search indices
  }

  private semanticSearch(query: string): MCPServerMetadata[] {
    // Use embeddings or fuzzy matching for semantic search
    // Match against descriptions, use cases, and tool capabilities
  }

  private scoreStaticCandidates(candidates: MCPServerMetadata[], request: MCPDiscoveryRequest): MCPDiscoveryResult[] {
    // Score based on semantic relevance, security rating, and reliability
    // Return scored candidates for final ranking
  }
}
```

#### Tier 3: Web Research Discovery
**File**: `packages/core/src/mcp-registry/web-discovery.ts`

```typescript
class WebMCPDiscovery {
  constructor(private webSearchTool: any) {}

  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    // 1. Generate search queries for MCP servers
    const searchQueries = this.generateSearchQueries(request);

    // 2. Search GitHub, NPM, and documentation sites
    const searchResults = await this.performWebSearch(searchQueries);

    // 3. Parse and validate discovered servers
    const validatedServers = await this.validateDiscoveredServers(searchResults);

    // 4. Score and generate configuration templates
    return this.scoreWebCandidates(validatedServers, request);
  }

  private generateSearchQueries(request: MCPDiscoveryRequest): string[] {
    return [
      `"MCP server" ${request.intent}`,
      `"Model Context Protocol" ${request.domain}`,
      `mcp-server ${request.capabilities?.join(' ')}`,
    ];
  }

  private async validateDiscoveredServers(results: WebSearchResult[]): Promise<MCPServerMetadata[]> {
    // Extract package.json, README, repository info
    // Validate MCP compliance
    // Check security indicators
  }

  private scoreWebCandidates(servers: MCPServerMetadata[], request: MCPDiscoveryRequest): MCPDiscoveryResult[] {
    // Score based on relevance, repository health, and security
    // Lower confidence scores due to lack of validation
    // Return scored candidates for final ranking
  }
}
```

### 3. Integration with Workspace Creation Flow

**Enhancement to**: `packages/system/agents/conversation/tools/workspace-creation/tools.ts`

```typescript
export const mcpDiscoveryTool = tool({
  description: "Discover the best MCP server for workspace capabilities",
  inputSchema: z.object({
    intent: z.string().describe("Natural language description of needed capabilities"),
    domain: z.string().optional().describe("Category filter: dev, cloud, analytics, etc."),
  }),
  execute: async ({ intent, domain }) => {
    const registry = await MCPRegistry.getInstance();
    const request: MCPDiscoveryRequest = { intent, domain };

    // Run all three tiers in parallel
    const [tier1, tier2, tier3] = await Promise.allSettled([
      registry.discoverFromAgents(request),
      registry.discoverFromStatic(request),
      registry.discoverFromWeb(request),
    ]);

    // Merge all candidates and select best match
    const allCandidates = this.mergeDiscoveryResults([tier1, tier2, tier3]);
    const bestMatch = this.selectBestMatch(allCandidates);

    if (!bestMatch) {
      return {
        success: false,
        error: "No suitable MCP server found for the requested capabilities",
      };
    }

    return {
      success: true,
      server: bestMatch.server,
      confidence: bestMatch.confidence,
      reasoning: bestMatch.reasoning,
      source: bestMatch.source,
      configuration: this.generateMCPConfiguration(bestMatch.server),
    };
  },

  // Helper methods for single-server selection
  mergeDiscoveryResults(tierResults: PromiseSettledResult<MCPDiscoveryResult[]>[]): MCPDiscoveryResult[] {
    const allCandidates: MCPDiscoveryResult[] = [];
    tierResults.forEach(result => {
      if (result.status === 'fulfilled') {
        allCandidates.push(...result.value);
      }
    });
    return allCandidates;
  },

  selectBestMatch(candidates: MCPDiscoveryResult[]): MCPDiscoveryResult | null {
    if (candidates.length === 0) return null;

    // Sort by confidence score descending, then by source tier priority
    const sourceRanking = { 'agents': 3, 'static': 2, 'web': 1 };
    return candidates.sort((a, b) => {
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      return sourceRanking[b.source] - sourceRanking[a.source];
    })[0];
  },

  generateMCPConfiguration(server: MCPServerMetadata): MCPServerConfig {
    return server.configTemplate;
  },
});
```

**Enhancement to**: `packages/system/agents/conversation/tools/workspace-creation/builder.ts`

```typescript
export class WorkspaceBuilder {
  // Add MCP server recommendation support
  async addRecommendedMCPServer(intent: string, domain?: string): Promise<ValidationResult> {
    const registry = await MCPRegistry.getInstance();
    const bestMatch = await registry.discoverBestMCPServer({ intent, domain });

    if (!bestMatch) {
      return {
        success: false,
        errors: [`No suitable MCP server found for: ${intent}`],
        warnings: []
      };
    }

    // Add the best match to workspace
    return this.addMCPServer(bestMatch.server.id, bestMatch.server.configTemplate);
  }

  private addMCPServer(serverId: string, config: MCPServerConfig): ValidationResult {
    try {
      const validated = MCPServerConfigSchema.parse(config);
      this.mcpServers.set(serverId, validated);
      return { success: true, errors: [], warnings: [] };
    } catch (error) {
      return { success: false, errors: [error.message], warnings: [] };
    }
  }
}
```

### 4. Enhanced Static Registry

**File**: `packages/system/agents/conversation/tools/mcp-servers-registry.json`

Transform the markdown guide into a structured JSON registry:

```json
{
  "servers": [
    {
      "id": "github-repos-manager",
      "name": "GitHub Integration",
      "description": "Comprehensive GitHub repository automation and management",
      "category": "development",
      "source": "community",
      "transportTypes": ["stdio"],
      "tools": [
        {
          "name": "list_repositories",
          "description": "List accessible repositories",
          "capabilities": ["repository-management"]
        }
      ],
      "useCases": [
        "repository management",
        "issue tracking",
        "team collaboration"
      ],
      "securityRating": "high",
      "configTemplate": {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "github-repos-manager-mcp"]
        },
        "auth": {
          "type": "bearer",
          "token_env": "GITHUB_TOKEN"
        },
        "tools": {
          "allow": ["list_repositories", "get_repository_info"]
        }
      },
      "documentation": "https://github.com/...",
      "repository": "https://github.com/..."
    }
  ],
  "categories": ["development", "cloud", "analytics", "automation", "communication"],
  "metadata": {
    "version": "1.0.0",
    "lastUpdated": "2025-01-27",
    "totalServers": 16
  }
}
```

### 5. Conversation Agent Integration

**Enhancement to**: `packages/system/agents/conversation/tools/mod.ts`

```typescript
// Add MCP registry tools to conversation agent
export const conversationTools = {
  ...workspaceBuilderTools,
  ...workspaceMemoryTools,
  mcpDiscovery: mcpDiscoveryTool,
  validateMCPServer: validateMCPServerTool,
  generateMCPConfig: generateMCPConfigTool,
  ...streamingTools,
};
```

**Enhancement to**: `packages/system/agents/conversation/prompt.txt`

Add MCP registry guidance to the conversation agent prompt:

```
<mcp_registry_integration>
# MCP Server Discovery and Recommendation

When users request automation capabilities that require external tools or integrations:

1. **Automatic Discovery**: Use the mcpDiscovery tool to find the best MCP server
   - Pass user's intent as natural language
   - Include domain filters when appropriate (dev, cloud, analytics, etc.)

2. **Multi-Tier Search**: The registry searches three tiers automatically:
   - Tier 1: Existing agent configurations and usage patterns
   - Tier 2: Curated list of production-ready servers
   - Tier 3: Web research for specialized or new servers

3. **Present Best Match**: Show the single best MCP server recommendation with:
   - Description of capabilities
   - Confidence score and source tier
   - Why it's the best match for requirements
   - Security and reliability information

4. **Configuration Generation**: Auto-generate MCP server configuration for workspace.yml

Example usage:
User: "I need to monitor GitHub repositories for security issues"
You: Call mcpDiscovery with intent="monitor GitHub repositories for security issues" and domain="development"
Result: Single best MCP server with high confidence score and reasoning
</mcp_registry_integration>
```

## Implementation Timeline

### Phase 1: Core Infrastructure
- [ ] Implement MCPRegistry service with single-server selection logic
- [ ] Create Tier 2 static discovery with JSON registry
- [ ] Transform existing mcp-servers-guide.md to structured JSON
- [ ] Add candidate scoring and ranking algorithms

### Phase 2: Agent Integration
- [ ] Implement Tier 1 agent-based discovery with confidence scoring
- [ ] Integrate with existing AgentRegistry
- [ ] Add single-server MCP discovery tool to workspace creation flow
- [ ] Update WorkspaceBuilder with best-match MCP recommendation

### Phase 3: Web Research
- [ ] Implement Tier 3 web discovery with validation scoring
- [ ] Add web search integration with security checks
- [ ] Implement repository parsing and compliance validation
- [ ] Add candidate merging and best-match selection

### Phase 4: Conversation Agent Enhancement
- [ ] Update conversation agent prompt for single-server recommendations
- [ ] Add MCP registry guidance emphasizing best-match selection
- [ ] Implement configuration generation for selected server
- [ ] Add confidence-based user approval flows

### Phase 5: Testing & Refinement
- [ ] Integration testing with single-server workspace creation
- [ ] Performance optimization for parallel tier execution
- [ ] Security validation and confidence threshold tuning
- [ ] Documentation for best-match selection algorithms

## Security Considerations

1. **Server Validation**: All discovered MCP servers must pass security validation
2. **Sandboxed Execution**: Web-discovered servers should run in restricted environments
3. **User Approval**: Tier 3 discoveries require explicit user confirmation
4. **Allow Lists**: Default to restrictive tool filtering for discovered servers
5. **Audit Logging**: Track all MCP server recommendations and usage

## Metrics and Monitoring

1. **Discovery Success Rates**: Track single-server selection success per tier
2. **Confidence Scores**: Monitor accuracy of confidence scoring vs. user acceptance
3. **Performance Metrics**: Response times for parallel tier execution and selection
4. **Security Events**: Failed validations and confidence threshold violations
5. **Selection Quality**: Track best-match accuracy and user satisfaction

## Future Enhancements

1. **Machine Learning**: Learn from user preferences and success rates
2. **Community Ratings**: Allow users to rate and review MCP servers
3. **Automated Testing**: Regular validation of recommended servers
4. **Custom Registries**: Support for organization-specific MCP registries
5. **Configuration Templates**: Smart template generation based on usage patterns

This implementation transforms Atlas's workspace creation from a manual, knowledge-intensive process to an intelligent, single-recommendation system that automatically selects the best MCP tool from the full ecosystem of available servers.
