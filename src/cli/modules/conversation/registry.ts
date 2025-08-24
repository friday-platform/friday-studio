import type { CommandDefinition } from "./types.ts";

// Command registry
export const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
  signal: { name: "signal", description: "View workspace signals", usage: "/signal list" },

  agent: { name: "agent", description: "View workspace agents", usage: "/agent list" },

  library: {
    name: "library",
    description: "View workspace library or open library items",
    usage: "/library [open <item_id>]",
  },

  session: { name: "session", description: "View workspace sessions", usage: "/session list" },

  version: { name: "version", description: "Show Atlas version information", usage: "/version" },

  clear: { name: "clear", description: "Clear the output buffer", usage: "/clear" },

  init: { name: "init", description: "Initialize a new workspace", usage: "/init" },

  credits: {
    name: "credits",
    description: "Show Atlas credits and acknowledgments",
    usage: "/credits",
  },

  status: { name: "status", description: "Status of the Atlas daemon", usage: "/status" },

  // config: {
  //   name: "config",
  //   description: "View and manage workspace configuration",
  //   usage: "/config [show|validate] [args...]",
  // },

  "send-diagnostics": {
    name: "send-diagnostics",
    description: "Send diagnostic information to Atlas developers",
    usage: "/send-diagnostics",
  },

  "enable-multiline": {
    name: "enable-multiline",
    description: "Configure terminal for multi-line input (macOS only)",
    usage: "/enable-multiline",
  },
};
