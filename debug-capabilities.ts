import { WorkspaceCapabilityRegistry } from "./src/core/workspace-capabilities.ts";

WorkspaceCapabilityRegistry.initialize();
console.log(
  "Available capabilities:",
  WorkspaceCapabilityRegistry.getAllCapabilities().map((c) => c.id),
);
console.log(
  "session_reply capability:",
  WorkspaceCapabilityRegistry.getCapability("session_reply"),
);

// Test filtering for conversation agent
const testFilter = {
  agentId: "conversation-agent",
  agentConfig: {
    tools: ["session_reply"],
  },
  grantedTools: [],
};

const filteredCapabilities = WorkspaceCapabilityRegistry.filterCapabilitiesForAgent(testFilter);
console.log("Filtered capabilities for conversation agent:", filteredCapabilities.map((c) => c.id));
