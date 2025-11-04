# MCP Server Discovery System

## Overview

A simplified discovery system that maps product names to MCP server configurations. The key insight: **the workspace planner already extracts specific product names** (like "Slack", "GitHub", "Google Calendar") when designing agents, so discovery becomes a simple lookup table.

### Key Design Decision

Instead of the previous "needs" approach with generic terms like "messaging" or "version-control", the planner now extracts specific product integrations directly. This makes discovery trivial and accurate.

## Architecture

### Data Flow

```
User Requirements
    ↓
Workspace Planner (extracts specific products)
    ↓
Discovery System (maps products to servers)
    ↓
Enricher (adds server configs to workspace)
```

### Key Components

```typescript
// Products come from workspace planner
type Agent = {
  name: string;
  description: string;
  integrations: string[]; // ["Slack", "GitHub", "Google Calendar"]
  configuration: Record<string, unknown>;
};

// Discovery maps products to servers
type DiscoveryResult = {
  servers: Array<{
    id: string;
    name: string;
    config: MCPServerConfig;
    product: string; // which product this server handles
  }>;
  unmatched: string[]; // products without matching servers
};
```

## Implementation

### 1. Workspace Planner Integration

The workspace planner extracts specific products during agent design:

```typescript
// In workspace-planner.agent.ts
const agentSchema = z.object({
  name: z.string(),
  description: z.string(),
  integrations: z.array(z.string()).describe(
    "Specific products/services this agent integrates with. Use proper names: 'Slack', 'GitHub', 'Google Calendar', 'Stripe'. NOT generic terms like 'messaging' or 'payments'."
  ),
  configuration: z.record(z.string(), z.unknown()).optional()
});

// Planner output example:
{
  "name": "Calendar Meeting Summarizer",
  "description": "Reads Google Calendar events and posts summaries to Slack",
  "integrations": ["Google Calendar", "Slack"],
  "configuration": { "channel": "#daily-standup" }
}
```

### 2. Product-to-Server Mapping

Build index mapping canonical product names to MCP servers:

```typescript
function buildProductIndex(): Map<string, RegistryItem> {
  const index = new Map();

  // Map product names to servers
  for (const server of Object.values(blessedMCPServers)) {
    if (server.id === "github-repos-manager") {
      index.set("GitHub", server);
      index.set("github", server); // lowercase variant
    }
    if (server.id === "stripe") {
      index.set("Stripe", server);
      index.set("stripe", server);
    }
    if (server.id === "linear") {
      index.set("Linear", server);
      index.set("linear", server);
    }
    // ... add all product mappings
  }

  return index;
}
```

### 3. Simple Discovery Function

Since products are already extracted by the planner, discovery is just a lookup:

```typescript
function discoverMCPServers(products: string[]): DiscoveryResult {
  const index = buildProductIndex();
  const matched = new Map<string, any>();
  const unmatched: string[] = [];

  for (const product of products) {
    // Try exact match
    let server = index.get(product);

    // Try lowercase variant
    if (!server) {
      server = index.get(product.toLowerCase());
    }

    // Try normalized form (Google Calendar -> google-calendar)
    if (!server) {
      const normalized = product.toLowerCase().replace(/\s+/g, "-");
      server = index.get(normalized);
    }

    if (server) {
      // Dedupe by server ID
      if (!matched.has(server.id)) {
        matched.set(server.id, {
          id: server.id,
          name: server.name,
          config: server.config,
          product: product,
        });
      }
    } else {
      unmatched.push(product);
    }
  }

  return {
    servers: Array.from(matched.values()),
    unmatched,
  };
}
```

## Usage Examples

### Complete Flow from Planner to Discovery

```typescript
// 1. Workspace planner extracts products from user requirements
const plannerOutput = {
  agents: [
    {
      name: "Issue Synchronizer",
      description: "Creates GitHub issues from Trello cards",
      integrations: ["GitHub", "Trello"],
      configuration: { board: "product-backlog" }
    }
  ]
};

// 2. Collect all unique products from all agents
const allProducts = new Set<string>();
for (const agent of plannerOutput.agents) {
  agent.integrations.forEach(p => allProducts.add(p));
}

// 3. Discover MCP servers for these products
const result = discoverMCPServers(Array.from(allProducts));

// Result:
{
  servers: [
    {
      id: "github-repos-manager",
      name: "GitHub Integration",
      config: { /* connection config */ },
      product: "GitHub"
    },
    {
      id: "trello",
      name: "Trello Board Management",
      config: { /* connection config */ },
      product: "Trello"
    }
  ],
  unmatched: []
}
```

### Integration with Workspace Enricher

```typescript
async function enrichWorkspace(workspacePlan: WorkspacePlan) {
  // Collect all integrations from all agents
  const products = workspacePlan.agents.flatMap((a) => a.integrations);
  const uniqueProducts = [...new Set(products)];

  // Discover MCP servers
  const discovery = discoverMCPServers(uniqueProducts);

  // Add server configs to workspace
  const mcpServers = discovery.servers.reduce(
    (acc, server) => {
      acc[server.id] = server.config;
      return acc;
    },
    {} as Record<string, MCPServerConfig>,
  );

  return {
    ...workspacePlan,
    mcpServers,
    _discovery: {
      matched: discovery.servers.map((s) => s.product),
      unmatched: discovery.unmatched,
    },
  };
}
```

### Handling Unmatched Products

```typescript
const products = ["Slack", "Google Calendar", "CustomCRM"];
const result = discoverMCPServers(products);

if (result.unmatched.length > 0) {
  console.log("Warning: No MCP servers found for:", result.unmatched);
  // ["Slack", "Google Calendar", "CustomCRM"]
  // These would need to be handled differently or added to registry
}
```

## Registry Structure

### Current Format

```typescript
type RegistryItem = {
  id: string;
  name: string;
  description: string;
  tools: { name: string; description: string }[];
  config: MCPServerConfig;
  documentation: string;
  repository: string;
  package: string;
};

export const blessedMCPServers: Record<string, RegistryItem> = {
  "github-repos-manager": {
    name: "GitHub Integration",
    description: "GitHub repository automation",
    config: {
      transport: { type: "stdio", command: "npx", args: [...] },
      auth: { type: "bearer", token_env: "GITHUB_TOKEN" },
      env: { GITHUB_TOKEN: "your-github-pat" }
    },
    // ...
  }
};
```

### Recommended Enhancement: Product Mapping

Add explicit product mappings to make discovery more accurate:

```typescript
// Product name mapping (could be separate or part of registry)
export const productMappings: Record<string, string> = {
  GitHub: "github-repos-manager",
  github: "github-repos-manager",
  Stripe: "stripe",
  stripe: "stripe",
  "Google Calendar": "google-calendar", // when added
  "Google Analytics": "google-analytics",
  Slack: "slack", // when added
  Trello: "trello",
  Linear: "linear",
  // ... etc
};
```

## Implementation Strategy

### Simplified Approach

Since the workspace planner extracts products, the discovery system becomes much simpler:

1. **Planner extracts products** - Uses LLM to identify specific integrations from user requirements
2. **Discovery maps products** - Simple lookup table maps products to MCP servers
3. **Enricher adds configs** - Server configurations added to workspace

### Data Flow

```
User: "Sync GitHub issues with Linear daily"
    ↓
Planner: agents[0].integrations = ["GitHub", "Linear"]
    ↓
Discovery: ["GitHub" → github-repos-manager, "Linear" → linear]
    ↓
Enricher: Add MCP configs to workspace
```

## Extension Points

### Adding New Services

1. Add to registry with server configuration:

```typescript
blessedMCPServers["slack"] = {
  id: "slack",
  name: "Slack Integration",
  description: "Slack messaging and notifications",
  config: {
    /* MCP server config */
  },
  // ... other fields
};
```

2. Add product mappings:

```typescript
productMappings["Slack"] = "slack";
productMappings["slack"] = "slack";
```

3. Update planner instructions to recognize the new product name

### Handling Product Variations

```typescript
// Handle common variations and aliases
const productAliases: Record<string, string> = {
  gh: "GitHub",
  "Google Cal": "Google Calendar",
  "G Suite": "Google Workspace",
  // ... etc
};

function normalizeProduct(product: string): string {
  return productAliases[product] || product;
}
```

## Testing

### Unit Tests

```typescript
describe("MCP Discovery", () => {
  it("maps products to servers", () => {
    const products = ["GitHub", "Stripe"];
    const result = discoverMCPServers(products);

    assertEquals(result.servers.length, 2);
    assertEquals(result.servers[0].id, "github-repos-manager");
    assertEquals(result.servers[1].id, "stripe");
  });

  it("handles case variations", () => {
    const products = ["github", "STRIPE", "Linear"];
    const result = discoverMCPServers(products);

    assertEquals(result.servers.length, 3);
    assertEquals(result.unmatched.length, 0);
  });

  it("reports unmatched products", () => {
    const products = ["Slack", "CustomCRM"];
    const result = discoverMCPServers(products);

    assertEquals(result.unmatched, ["Slack", "CustomCRM"]);
  });
});
```

### Integration Tests

Test planner → discovery → enricher pipeline:

```typescript
describe("Full Pipeline", () => {
  it("processes workspace plan with integrations", () => {
    const plan = {
      agents: [
        {
          name: "Sync Agent",
          integrations: ["GitHub", "Linear"],
          // ...
        },
      ],
    };

    const enriched = enrichWorkspace(plan);

    assertExists(enriched.mcpServers["github-repos-manager"]);
    assertExists(enriched.mcpServers["linear"]);
  });
});
```

## Migration Guide

To implement this simplified approach:

1. **Update workspace planner** (`workspace-planner.agent.ts`):
   - Change `needs` field to `integrations`
   - Update prompt to request specific product names
   - Add examples of proper product names in schema description

2. **Create product mappings**:
   - Build `productMappings` object mapping product names to server IDs
   - Include common variations (capitalized, lowercase, etc.)

3. **Simplify discovery function**:
   - Remove pattern matching logic
   - Implement simple lookup with fallbacks
   - Return products that don't match

4. **Update enricher** (`mcp-servers.ts`):
   - Collect integrations instead of needs
   - Pass products to simplified discovery
   - Handle unmatched products appropriately

5. **Test the pipeline**:
   - Verify planner extracts correct product names
   - Ensure discovery maps all common products
   - Check enricher adds correct configs
