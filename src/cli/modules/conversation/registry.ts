import { CommandDefinition } from "./types.ts";
import {
  handleAgentsCommand,
  handleClearCommand,
  handleConfigCommand,
  handleCreditsCommand,
  handleInitCommand,
  handleLibraryCommand,
  handleMarkdownCommand,
  handleSessionsCommand,
  handleSignalsCommand,
  handleStatusCommand,
  handleVersionCommand,
  handleWorkspacesCommand,
} from "./commands.tsx";

// Command registry
export const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
  // help command is handled separately with view change

  // exit command is handled separately

  workspaces: {
    name: "workspaces",
    description: "View available workspaces",
    usage: "/workspaces",
    handler: handleWorkspacesCommand,
  },

  signal: {
    name: "signal",
    description: "View workspace signals",
    usage: "/signal list",
    handler: handleSignalsCommand,
  },

  agent: {
    name: "agent",
    description: "View workspace agents",
    usage: "/agent list",
    handler: handleAgentsCommand,
  },

  library: {
    name: "library",
    description: "View workspace library or open library items",
    usage: "/library [open <item_id>]",
    handler: handleLibraryCommand,
  },

  session: {
    name: "session",
    description: "View workspace sessions",
    usage: "/session list",
    handler: handleSessionsCommand,
  },

  version: {
    name: "version",
    description: "Show Atlas version information",
    usage: "/version",
    handler: handleVersionCommand,
  },

  clear: {
    name: "clear",
    description: "Clear the output buffer",
    usage: "/clear",
    handler: handleClearCommand,
  },

  init: {
    name: "init",
    description: "Initialize a new workspace",
    usage: "/init",
    handler: handleInitCommand,
  },

  credits: {
    name: "credits",
    description: "Show Atlas credits and acknowledgments",
    usage: "/credits",
    handler: handleCreditsCommand,
  },

  status: {
    name: "status",
    description: "Check Atlas daemon status",
    usage: "/status",
    handler: handleStatusCommand,
  },

  config: {
    name: "config",
    description: "View and manage workspace configuration",
    usage: "/config [show|validate] [args...]",
    handler: handleConfigCommand,
  },

  markdown: {
    name: "markdown",
    description: "Display markdown syntax examples",
    usage: "/markdown",
    handler: handleMarkdownCommand,
  },
};
