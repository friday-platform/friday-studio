#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

import React from "react";
import { render } from "ink";
import meow from "meow";
import App from "./cli/app.tsx";

// Handle --version and -v flags manually (before meow processes them)
if (Deno.args.includes("--version") || Deno.args.includes("-v")) {
  const { getAtlasVersion } = await import("./utils/version.ts");
  console.log(getAtlasVersion());
  Deno.exit(0);
}

const cli = meow(
  `
  Usage
    $ atlas <command> <subcommand> [options]

  Commands
    work [init|serve|status|list]             Workspace management (defaults to serve)
    define <workspace-id>                     Show workspace definition and agents
    sig [<name>|list|history]                 Signal operations (defaults to trigger if name provided)
    sesh [list|get|cancel]                    Session management (defaults to list)
    agent [list|describe|test]                Agent management (defaults to list)
    library [list|search|get|templates]       Library and template management
    logs <session-id>                         Stream session logs
    ps                                        List active sessions
    tui [--workspace <name>]                  Terminal User Interface
    version [--json]                          Show Atlas version information
    help                                      Show this help
    
  Full Commands
    workspace init <name> [path]              Initialize a new workspace
    workspace serve [-d|--detached]           Start workspace server (use -d for background)
    workspace list                            List all workspaces
    workspace status [id|name] [--json]       Show workspace status (--json for raw health data)
    workspace stop <id|name> [--force]        Stop a running workspace
    workspace restart <id|name>               Restart a workspace
    workspace remove <id|name>                Remove workspace from registry
    workspace cleanup                         Clean up stale registry entries
    workspace logs [id|name]                  View workspace logs
    
    session list                              List all active sessions
    session get <id>                          Show session details
    session cancel <id>                       Cancel a running session
    
    signal list                               List all signals
    signal trigger <name> --data <json>       Trigger a signal with data
    signal history                            Show signal history
    
    agent list                                List all agents
    agent describe <name>                     Show agent details
    agent test <name> --message <text>        Test an agent
    
    library list [--type <type>] [--tags <tags>]  List library items
    library search <query>                    Search library content
    library get <id> [--content]             Get library item details
    library templates                        List available templates
    library generate <template> <data.json>  Generate content from template
    library stats                            Show library statistics

  Examples
    $ atlas workspace init my-project
    $ atlas workspace serve
    $ atlas define k8s-assistant
    $ atlas signal trigger telephone-message --data '{"message": "Hello"}'
    $ atlas ps
    $ atlas logs sess_abc123
`,
  {
    importMeta: import.meta,
    flags: {
      owner: {
        type: "string",
        shortFlag: "o",
      },
      name: {
        type: "string",
        shortFlag: "n",
      },
      workspace: {
        type: "string",
        shortFlag: "w",
      },
      agent: {
        type: "string",
        shortFlag: "a",
      },
      model: {
        type: "string",
        shortFlag: "m",
      },
      message: {
        type: "string",
      },
      lazy: {
        type: "boolean",
        shortFlag: "l",
        default: false,
      },
      port: {
        type: "number",
        shortFlag: "p",
      },
      data: {
        type: "string",
      },
      follow: {
        type: "boolean",
        shortFlag: "f",
        default: false,
      },
      tail: {
        type: "number",
        default: 100,
      },
      since: {
        type: "string",
      },
      timestamps: {
        type: "boolean",
        default: true,
      },
      json: {
        type: "boolean",
        default: false,
      },
      level: {
        type: "string",
      },
      context: {
        type: "string",
        isMultiple: true,
      },
      detached: {
        type: "boolean",
        shortFlag: "d",
        default: false,
      },
      internalDetached: {
        type: "boolean",
        default: false,
      },
      workspaceId: {
        type: "string",
      },
      logFile: {
        type: "string",
      },
    },
  },
);

// Parse command with shorthand support
let [command, subcommand, ...args] = cli.input;

// Natural shorthands (shown in help) - includes singular/plural
const naturalShorthands: Record<string, string> = {
  // Workspace variants
  work: "workspace",
  workspace: "workspace",

  // Signal variants
  sig: "signal",
  signal: "signal",
  signals: "signal",

  // Session variants
  sesh: "session",
  sess: "session",
  session: "session",
  sessions: "session",

  // Agent variants
  agent: "agent",
  agents: "agent",

  // Log variants
  log: "logs",
  logs: "logs",
};

// Hidden single-letter shortcuts (power users)
const hiddenShorthands: Record<string, string> = {
  w: "work",
  s: "sesh",
  x: "sig",
  a: "agent",
  l: "logs",
  h: "help",
  "?": "help",
};

// Smart defaults when no subcommand provided
const commandDefaults: Record<string, string> = {
  work: "serve", // atlas work → workspace serve
  workspace: "serve", // atlas workspace → workspace serve
  sig: "trigger", // atlas sig <name> → signal trigger <name>
  signal: "list", // atlas signal → signal list
  sesh: "list", // atlas sesh → session list
  sess: "list", // atlas sess → session list
  session: "list", // atlas session → session list
  agent: "list", // atlas agent → agent list
};

// All shorthands combined
const allShorthands = { ...naturalShorthands, ...hiddenShorthands };

// Apply shorthand expansion for main command
if (allShorthands[command]) {
  command = allShorthands[command];
}

// Also apply shorthand expansion for subcommand if it's a nested natural command
// e.g., "atlas workspace signals" → "atlas workspace signal"
if (subcommand && naturalShorthands[subcommand]) {
  // Check if this might be a nested command structure
  const expandedSub = naturalShorthands[subcommand];
  if (expandedSub !== subcommand) {
    subcommand = expandedSub;
  }
}

// Apply smart defaults if no subcommand
if (!subcommand && commandDefaults[command]) {
  // Special case for 'sig' - if args exist, it's a trigger
  if ((command === "sig" || command === "signal") && args.length > 0) {
    subcommand = "trigger";
  } else {
    subcommand = commandDefaults[command];
  }
} else if (
  (command === "sig" || command === "signal") &&
  subcommand &&
  !["list", "trigger", "history"].includes(subcommand)
) {
  // If subcommand looks like a signal name, shift arguments
  args = [subcommand, ...args];
  subcommand = "trigger";
}

// Handle nested workspace commands (e.g., "atlas workspace sessions")
// But exclude "logs" since it's a valid workspace subcommand
if (
  command === "workspace" &&
  subcommand &&
  naturalShorthands[subcommand] &&
  subcommand !== "logs"
) {
  // This is a cross-command request like "workspace sessions"
  // Redirect to the appropriate command
  command = naturalShorthands[subcommand];
  subcommand = args[0] || "list";
  args = args.slice(1);
}

// For workspace logs command, use direct implementation to avoid Ink's raw mode issues
if (command === "workspace" && subcommand === "logs") {
  // Initialize registry first
  import("./core/workspace-registry.ts")
    .then(async ({ getWorkspaceRegistry }) => {
      const registry = getWorkspaceRegistry();
      await registry.initialize();

      // Then run logs command
      const { runWorkspaceLogs } = await import(
        "./cli/commands/workspace/logs/logs-direct.ts"
      );
      await runWorkspaceLogs(args, cli.flags);
    })
    .catch((err) => {
      console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      Deno.exit(1);
    });
} else {
  // Test: Try without withFullScreen to see if that's causing the resize issue
  render(
    React.createElement(App, {
      command,
      subcommand,
      args,
      flags: cli.flags,
    }),
  );
}
