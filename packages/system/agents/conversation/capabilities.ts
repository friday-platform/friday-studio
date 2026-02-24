import { bundledAgents } from "@atlas/bundled-agents";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";

/**
 * Generate capabilities XML section for system prompt.
 *
 * Three-tier structure:
 * 1. `<builtin_capabilities>` - Tools every agent gets for free. No capability ID needed.
 * 2. `<bundled_agents>` - Zero-config agents, always available via do_task.
 * 3. `<mcp_servers>` - External integrations requiring configuration.
 *
 * The builtin section guides the LLM toward `capabilities: []` when built-in tools suffice.
 * LLM sees bundled agents next, preferring them when they cover the capability.
 *
 * @param dynamicServers - Runtime-registered MCP servers from KV (not in static registry)
 */
export function getCapabilitiesSection(dynamicServers?: MCPServerMetadata[]): string {
  const agentsXml = bundledAgents
    .map((agent) => {
      const constraints = agent.metadata.constraints
        ? `\n  <constraints>${agent.metadata.constraints}</constraints>`
        : "";
      return `<agent id="${agent.metadata.id}">${agent.metadata.description}${constraints}</agent>`;
    })
    .join("\n");

  const staticServers = Object.values(mcpServersRegistry.servers);
  const staticIds = new Set(staticServers.map((s) => s.id));
  const extraServers = (dynamicServers ?? []).filter((s) => !staticIds.has(s.id));
  const allServers = [...staticServers, ...extraServers];

  const serversXml = allServers
    .map((server) => {
      const constraints = server.constraints
        ? `\n  <constraints>${server.constraints}</constraints>`
        : "";
      const desc = server.description ?? server.name;
      return `<server id="${server.id}">${desc}${constraints}</server>`;
    })
    .join("\n");

  return `<builtin_capabilities>
<!-- Every agent gets these automatically. No capability ID needed. -->
<!-- Select capabilities: [] when these are sufficient. -->
<tool id="resource_read">SELECT queries on workspace resource tables</tool>
<tool id="resource_write">INSERT/UPDATE/DELETE on workspace resource tables</tool>
<tool id="webfetch">Fetch content from public URLs</tool>
<tool id="artifacts">Create and read artifacts (reports, files, data)</tool>

Select capabilities: [] when:
- The agent reads or writes workspace resource tables (CRUD)
- The agent transforms data between pipeline steps using LLM reasoning
- The agent does text processing, formatting, or decision-making
- The agent needs simple URL fetching (not deep web research)

Select a capability when:
- The agent must interact with an external service (Slack, Gmail, GitHub)
- The agent needs specialized execution (DuckDB analytics, code sandbox)
</builtin_capabilities>

<bundled_agents>
<!-- Check here FIRST. Zero-config, always available via do_task. -->
${agentsXml}
</bundled_agents>

<mcp_servers>
<!-- Use when bundled agents dont cover the capability. Require configuration. -->
${serversXml}
</mcp_servers>`;
}
