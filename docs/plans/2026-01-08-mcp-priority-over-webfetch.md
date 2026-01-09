# MCP Priority Over Webfetch

**Issue**: atlas-yrk
**Date**: 2026-01-08

## Problem

When users request URLs like `https://linear.app/team/issue/TEM-123`, the planner defaults to `webfetch` instead of using the dedicated MCP (Linear). This results in broken responses since webfetch can't render JavaScript-heavy pages.

## Solution

Add domain-to-MCP mappings and enforce the tool selection priority:

1. Bundled agents
2. All MCPs (even disconnected - trigger connection flow)
3. webfetch (last resort for generic URLs)

## Changes

### 1. MCP Registry: Add Domain Mappings

**File**: `packages/core/src/mcp-registry/registry-consolidated.ts`

Add `domains` field to each MCP entry:

```typescript
linear: {
  id: "linear",
  name: "Linear Project Management",
  domains: ["linear.app", "linear.so"],
  // ... rest of config
},
github: {
  id: "github",
  name: "GitHub",
  domains: ["github.com", "githubusercontent.com"],
  // ...
},
```

### 2. Integrations Context: Include Domains

**File**: `packages/system/agents/conversation/link-context.ts`

Update `formatIntegrationsSection()` to include domains from MCP registry:

```typescript
import { getMCPRegistry } from "@atlas/core/mcp-registry";

export function formatIntegrationsSection(summary: SummaryResponse): string {
  const { credentials, providers } = summary;
  const registry = getMCPRegistry();

  const credentialLabels = new Map<string, string>();
  for (const cred of credentials) {
    const existing = credentialLabels.get(cred.provider);
    credentialLabels.set(cred.provider, existing ? `${existing}, ${cred.label}` : cred.label);
  }

  let section = "<integrations>\n";
  for (const provider of providers) {
    const label = credentialLabels.get(provider.id);
    const mcpEntry = registry[provider.id];
    const domains = mcpEntry?.domains?.join(",") ?? "";

    if (label) {
      section += `  <service id="${provider.id}" status="ready" label="${label}" domains="${domains}"/>\n`;
    } else {
      section += `  <service id="${provider.id}" status="unconnected" domains="${domains}"/>\n`;
    }
  }
  section += "</integrations>";
  return section;
}
```

Output:
```xml
<integrations>
  <service id="linear" status="ready" label="Tempest Labs" domains="linear.app,linear.so"/>
  <service id="github" status="unconnected" domains="github.com,githubusercontent.com"/>
</integrations>
```

### 3. Conversation Agent Prompt: URL Handling

**File**: `packages/system/agents/conversation/prompt.txt`

Add instructions:

```
## URL Handling

When the user's request contains URLs, check if the domain matches a service in <integrations>:

1. Extract domains from URLs in the request
2. Match against service domains attribute
3. If service status="unconnected" → call connect_service first
4. If service status="ready" → proceed with do_task

Example:
- User asks about "https://linear.app/team/issue/TEM-123"
- Domain "linear.app" matches service id="linear"
- If linear status="unconnected" → call connect_service({ provider: "linear" })
- If linear status="ready" → call do_task with the request
```

### 4. Planner: Accept MCP Context

**File**: `packages/system/agents/conversation/tools/do-task/planner.ts`

Update function signature:

```typescript
export async function planTaskEnhanced(
  intent: string,
  agents: CatalogAgent[],
  mcpContext: { id: string; domains: string[]; connected: boolean }[],
  abortSignal?: AbortSignal,
)
```

Update prompt to include MCP priority:

```
## Tool Selection Priority

1. Bundled agents (check available agents first)
2. MCP tools (check available MCPs by domain)
3. webfetch (only if no MCP matches the URL domain)

Available MCPs:
${mcpContext.map(m => `- ${m.id}: ${m.domains.join(", ")}`).join("\n")}

If a URL domain matches an MCP, use needs=["<mcp-id>"], NOT webfetch.
```

Remove the line: `CRITICAL: For URL fetching, use executionType="llm" with needs=[].`

### 5. do_task Tool: Pass MCP Context

**File**: `packages/system/agents/conversation/tools/do-task/index.ts`

```typescript
import { getMCPRegistry } from "@atlas/core/mcp-registry";
import { fetchLinkSummary } from "../../link-context.ts";

// Inside execute():
const registry = getMCPRegistry();
const linkSummary = await fetchLinkSummary(logger);

const mcpContext = Object.entries(registry).map(([id, entry]) => ({
  id,
  domains: entry.domains ?? [],
  connected: linkSummary?.credentials.some(c => c.provider === id) ?? false,
}));

const planResult = await planTaskEnhanced(intent, catalog, mcpContext, abortSignal);
```

## Flow

```
User: "Summarize https://linear.app/team/TEM-123"
    ↓
Conversation agent sees linear.app → checks integrations
    ↓
If unconnected → connect_service({ provider: "linear" }) → user connects → retry
    ↓
If connected → do_task
    ↓
Planner sees linear.app + MCP context → needs=["linear"] (not webfetch)
    ↓
Executes with Linear MCP tools
```

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/mcp-registry/registry-consolidated.ts` | Add `domains` field |
| `packages/system/agents/conversation/link-context.ts` | Include `domains` in XML |
| `packages/system/agents/conversation/prompt.txt` | Add URL handling instructions |
| `packages/system/agents/conversation/tools/do-task/planner.ts` | Accept MCP context, update priority |
| `packages/system/agents/conversation/tools/do-task/index.ts` | Build and pass MCP context |
