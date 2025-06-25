import { handler as sessionListHandler } from "./session/list.tsx";

export const command = "ps";
export const desc = "List active sessions (alias for 'session list')";

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output session list as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    describe: "Filter sessions by workspace name",
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server",
    default: 8080,
  },
};

// Forward to session list handler
export const handler = sessionListHandler;
