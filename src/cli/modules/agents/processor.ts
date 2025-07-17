import { type WorkspaceConfig } from "@atlas/config";
import { type Agent } from "./agent-list-component.tsx";

// Transform workspace config agents into Agent array
export function processAgentsFromConfig(config: WorkspaceConfig): Agent[] {
  return Object.entries(config.agents || {}).map(([id, agent]) => {
    switch (agent.type) {
      case "llm":
        return {
          name: id,
          type: agent.type,
          model: agent.config.model || "claude-3-7-sonnet-latest",
          status: "ready",
        };
      default:
        return {
          name: id,
          type: agent.type,
          model: "unknown",
          status: "unknown",
        };
    }
  });
}
