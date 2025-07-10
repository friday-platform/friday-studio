export const OPENAPI_DOCUMENTATION = {
  openapi: "3.0.0",
  info: {
    title: "Atlas Daemon API",
    version: "1.0.0",
    description: "API for managing workspaces, sessions, and AI agent orchestration",
  },
  tags: [
    { name: "System", description: "System health and status endpoints" },
    { name: "Workspaces", description: "Workspace management operations" },
    { name: "Sessions", description: "Session management operations" },
    { name: "Library", description: "Library storage operations" },
    { name: "Daemon", description: "Daemon control operations" },
  ],
};
