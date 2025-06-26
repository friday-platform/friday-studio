import { type WorkspaceConfig } from "../../../core/config-loader.ts";
import { type Agent } from "./agent-list-component.tsx";

// Transform workspace config agents into Agent array
export function processAgentsFromConfig(config: WorkspaceConfig): Agent[] {
  return Object.entries(config.agents || {}).map(([id, agent]) => ({
    name: id,
    type: agent.type || "local",
    model: agent.model || "claude-3-5-sonnet-20241022",
    status: "ready",
    purpose: agent.purpose || "No description",
  }));
}
