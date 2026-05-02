export const OPENAPI_DOCUMENTATION = {
  info: {
    title: "Atlas Daemon API",
    version: "1.0.0",
    description: "API for managing workspaces, sessions, and AI agent orchestration",
  },
  tags: [
    { name: "System", description: "System health and status endpoints" },
    { name: "Workspaces", description: "Workspace management operations" },
    { name: "Signals", description: "Workspace signal triggering and management operations" },
    { name: "Sessions", description: "Session management operations" },
    { name: "Daemon", description: "Daemon control operations" },
    { name: "Agents", description: "Agent discovery and metadata operations" },
  ],
};
