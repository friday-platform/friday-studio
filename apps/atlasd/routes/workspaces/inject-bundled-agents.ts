// Shared helper — hydrates implicit credential refs on `type: atlas`
// agents from the bundled-agents registry. Lives outside index.ts so
// bundle-helpers.ts can import it without creating a module cycle.

import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { WorkspaceConfig } from "@atlas/config";

export function injectBundledAgentRefs(config: WorkspaceConfig): WorkspaceConfig {
  const agents = config.agents;
  if (!agents) return config;

  let needsUpdate = false;
  const updatedAgents: Record<string, (typeof agents)[string]> = {};

  for (const [id, agent] of Object.entries(agents)) {
    if (agent.type !== "atlas") {
      updatedAgents[id] = agent;
      continue;
    }

    const entry = bundledAgentsRegistry[agent.agent];
    if (!entry) {
      updatedAgents[id] = agent;
      continue;
    }

    const missingRefs: Record<string, { from: "link"; provider: string; key: string }> = {};
    for (const field of entry.requiredConfig) {
      if (field.from !== "link") continue;
      if (agent.env?.[field.envKey]) continue;
      missingRefs[field.envKey] = { from: "link", provider: field.provider, key: field.key };
    }

    if (Object.keys(missingRefs).length === 0) {
      updatedAgents[id] = agent;
      continue;
    }

    needsUpdate = true;
    updatedAgents[id] = { ...agent, env: { ...agent.env, ...missingRefs } };
  }

  if (!needsUpdate) return config;
  return { ...config, agents: updatedAgents };
}
