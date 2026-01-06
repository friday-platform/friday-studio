import { bundledAgents } from "@atlas/bundled-agents";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";

/**
 * Generate capabilities XML section for system prompt.
 *
 * Two-tier structure:
 * 1. `<bundled_agents>` - Zero-config agents, always available via do_task. PREFER THESE.
 * 2. `<mcp_servers>` - External integrations requiring configuration.
 *
 * LLM sees bundled agents first, naturally preferring them when they cover the capability.
 */
export function getCapabilitiesSection(): string {
  const agentsXml = bundledAgents
    .map((agent) => {
      const domains = agent.metadata.expertise?.domains?.join(", ") ?? "";
      const constraints = agent.metadata.constraints
        ? `\n  <constraints>${agent.metadata.constraints}</constraints>`
        : "";
      return `<agent id="${agent.metadata.id}" domains="${domains}">${agent.metadata.description}${constraints}</agent>`;
    })
    .join("\n");

  const serversXml = Object.values(mcpServersRegistry.servers)
    .map(
      (server) =>
        `<server id="${server.id}" domains="${server.domains.join(", ")}">${server.name}</server>`,
    )
    .join("\n");

  return `<bundled_agents>
<!-- Check here FIRST. Zero-config, always available via do_task. -->
${agentsXml}
</bundled_agents>

<mcp_servers>
<!-- Use when bundled agents dont cover the capability. Require configuration. -->
${serversXml}
</mcp_servers>`;
}
