import { defaultTheme, extendTheme, Select, Spinner, ThemeProvider } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import Help from "../views/help.tsx";
import { Newline } from "../views/Newline.tsx";
import { InitView } from "../views/InitView.tsx";
import CreditsView from "../views/CreditsView.tsx";
import { checkDaemonRunning, getDaemonClient } from "../utils/daemon-client.ts";
import { WorkspaceEntry, WorkspaceStatus } from "../../core/workspace-manager.ts";
import { SignalListComponent } from "../modules/signals/SignalListComponent.tsx";
import { AgentListComponent } from "../modules/agents/agent-list-component.tsx";
import { processAgentsFromConfig } from "../modules/agents/processor.ts";
import { LibraryListComponent } from "../modules/library/library-list-component.tsx";
import { fetchLibraryItems } from "../modules/library/fetcher.ts";
import { SessionListComponent } from "../modules/sessions/session-list-component.tsx";
import { fetchSessions } from "../modules/sessions/fetcher.ts"; // TODO: Update to use daemon API
import { loadWorkspaceConfigNoCwd } from "../modules/workspaces/resolver.ts";
import { SignalSelection } from "../components/signal-selection.tsx";
import { SessionSelection } from "../components/session-selection.tsx";
import { AgentSelection } from "../components/agent-selection.tsx";
import { formatVersionDisplay, getVersionInfo } from "../../utils/version.ts";
import { TextInput } from "../components/text-input/text-input.tsx";
import { COMMAND_DEFINITIONS } from "../utils/command-definitions.ts";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces",
    );
}

// Helper function to get workspace by ID using daemon API or fallback
const getWorkspaceById = async (workspaceId: string) => {
  if (await checkDaemonRunning()) {
    try {
      const client = getDaemonClient();
      return await client.getWorkspace(workspaceId);
    } catch (error) {
      console.warn("Daemon API call failed, workspace not found:", error);
      return null;
    }
  } else {
    console.warn("Daemon not running, cannot resolve workspace");
    return null;
  }
};

// Custom theme with yellow highlights for Select components
const customTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: "yellow" }),
        label: ({ isFocused, isSelected }) => ({
          color: isSelected ? "yellow" : isFocused ? "yellow" : undefined,
        }),
      },
    },
  },
});

export function handler() {
  render(
    <ThemeProvider theme={customTheme}>
      <InteractiveCommand />
    </ThemeProvider>,
  );
}

interface ConversationEntry {
  id: string;
  type: "user" | "system" | "command_output" | "error" | "intro";
  content: string;
  timestamp: Date;
}

// Parse command arguments while preserving complex arguments
interface ParsedCommand {
  command: string;
  args: string[];
  rawInput: string;
}

const parseSlashCommand = (input: string): ParsedCommand | null => {
  if (!input.startsWith("/")) {
    return null;
  }

  const trimmed = input.slice(1).trim();
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  let i = 0;

  while (i < trimmed.length) {
    const char = trimmed[i];

    if (char === '"' && braceDepth === 0) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      braceDepth--;
      current += char;
    } else if (char === " " && !inQuotes && braceDepth === 0) {
      if (current.trim()) {
        args.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  if (args.length === 0) {
    return null;
  }

  return {
    command: args[0].toLowerCase(),
    args: args.slice(1),
    rawInput: input,
  };
};

// Command context for handlers
interface CommandContext {
  addEntry: (entry: OutputEntry) => void;
  exit: () => void;
}

// Command definition interface
interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[], context: CommandContext) => OutputEntry[];
}

// Command handlers

const handleWorkspacesCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `workspaces-trigger-${Date.now()}`,
    component: <Text>Select a workspace:</Text>,
  });
  return [];
};

const handleSignalsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode for signals
  context.addEntry({
    id: `signals-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its signals:</Text>,
  });
  return [];
};

const handleAgentsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `agents-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its agents:</Text>,
  });
  return [];
};

const handleLibraryCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `library-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its library:</Text>,
  });
  return [];
};

const handleSessionsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `sessions-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its sessions:</Text>,
  });
  return [];
};

const handleVersionCommand = (_args: string[]): OutputEntry[] => {
  const versionInfo = getVersionInfo();
  const versionLines = formatVersionDisplay(versionInfo);

  return versionLines.map((line, index) => ({
    id: `version-line-${Date.now()}-${index}`,
    component: <Text>{line}</Text>,
  }));
};

const handleClearCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Clear the output buffer by setting it to empty
  context.addEntry({
    id: `clear-${Date.now()}`,
    component: <Text dimColor>Output cleared</Text>,
  });
  return [];
};

const handleInitCommand = (_args: string[]): OutputEntry[] => {
  // Init command switches to its own view, no output entries needed
  return [];
};

const handleCreditsCommand = (_args: string[]): OutputEntry[] => {
  // Credits command switches to its own view, no output entries needed
  return [];
};

const handleSessionCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `session-output-${Date.now()}`,
      component: <Text>Session {subcommand} executed (placeholder implementation)</Text>,
    },
  ];
};

const handleSignalCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `signal-output-${Date.now()}`,
      component: <Text>Signal {subcommand} executed (placeholder implementation)</Text>,
    },
  ];
};

const handleAgentCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `agent-output-${Date.now()}`,
      component: <Text>Agent {subcommand} executed (placeholder implementation)</Text>,
    },
  ];
};

const handleConfigCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "show";
  return [
    {
      id: `config-output-${Date.now()}`,
      component: <Text>Config {subcommand} executed (placeholder implementation)</Text>,
    },
  ];
};

// Command registry
const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
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
    description: "View workspace library",
    usage: "/library",
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

  session: {
    name: "session",
    description: "Manage workspace sessions",
    usage: "/session [list|get|kill] [args...]",
    handler: handleSessionCommand,
  },

  signal: {
    name: "signal",
    description: "Manage and trigger workspace signals",
    usage: "/signal [list|trigger] [args...]",
    handler: handleSignalCommand,
  },

  agent: {
    name: "agent",
    description: "Manage workspace agents",
    usage: "/agent [list|describe|status] [args...]",
    handler: handleAgentCommand,
  },

  config: {
    name: "config",
    description: "View and manage workspace configuration",
    usage: "/config [show|validate] [args...]",
    handler: handleConfigCommand,
  },
};

// Output buffer entry that can hold different component types
interface OutputEntry {
  id: string;
  component: React.ReactElement;
}

export default function InteractiveCommand() {
  const [_inputValue, _setInputValue] = useState("");
  const [view, setView] = useState<"help" | "command" | "init" | "credits">(
    "command",
  );
  const [_minHeight, setMinHeight] = useState(35);
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const [showWorkspaceSelection, setShowWorkspaceSelection] = useState(false);
  const [
    showWorkspacesWorkspaceSelection,
    setShowWorkspacesWorkspaceSelection,
  ] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );
  const [_loadingSignals, setLoadingSignals] = useState(false);
  const [showAgentWorkspaceSelection, setShowAgentWorkspaceSelection] = useState(false);
  const [_loadingAgents, setLoadingAgents] = useState(false);
  const [showLibraryWorkspaceSelection, setShowLibraryWorkspaceSelection] = useState(false);
  const [_loadingLibrary, setLoadingLibrary] = useState(false);
  const [showSessionsWorkspaceSelection, setShowSessionsWorkspaceSelection] = useState(false);
  const [_loadingSessions, setLoadingSessions] = useState(false);
  const [showSignalSelection, setShowSignalSelection] = useState(false);
  const [showSessionSelection, setShowSessionSelection] = useState(false);
  const [showAgentSelection, setShowAgentSelection] = useState(false);
  const [currentSelectionWorkspace, setCurrentSelectionWorkspace] = useState<string | null>(null);
  const [workspaceSelectionContext, setWorkspaceSelectionContext] = useState<
    | "signals-list"
    | "agents-list"
    | "sessions-list"
    | "library"
    | "workspaces"
    | "signals-select"
    | "agents-select"
    | "sessions-select"
    | null
  >(null);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Calculate available height for conversation display
  const availableHeight = Math.max(20, (stdout.rows || 24) - 8); // Reserve space for input

  useEffect(() => {
    const requiredHeight = Math.max(35, availableHeight + 8);
    setMinHeight(requiredHeight);
  }, [availableHeight]);

  // Add intro message on startup
  useEffect(() => {
    setOutputBuffer([]);
  }, []);

  // Add entry to output buffer
  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  // Handle workspace selection for workspaces command
  const handleWorkspaceSelectForWorkspaces = async (workspaceId: string) => {
    setShowWorkspacesWorkspaceSelection(false);

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (workspace) {
        setSelectedWorkspace(workspace.name);
      }
    } catch (error) {
      addOutputEntry({
        id: `workspace-error-${Date.now()}`,
        component: (
          <Text color="red">
            Error selecting workspace: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }
  };

  // Handle workspace selection for signals (list view)
  const handleWorkspaceSelectForSignalsList = async (workspaceId: string) => {
    setShowWorkspaceSelection(false);
    setLoadingSignals(true);

    // Add loading entry
    addOutputEntry({
      id: `loading-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Loading signals..." />
        </Box>
      ),
    });

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const config = await loadWorkspaceConfigNoCwd(workspace.path);
      const signalEntries = Object.entries(config.signals || {});

      // Remove loading entry and add signals table
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });
      addOutputEntry({
        id: `signals-table-${Date.now()}`,
        component: (
          <SignalListComponent
            signalEntries={signalEntries}
            workspaceName={workspace.name}
          />
        ),
      });
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            Error loading signals: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    } finally {
      setLoadingSignals(false);
    }
  };

  // Handle workspace selection for agents
  const handleWorkspaceSelectForAgents = async (workspaceId: string) => {
    setShowAgentWorkspaceSelection(false);
    setLoadingAgents(true);

    // Add loading entry
    addOutputEntry({
      id: `loading-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Loading agents..." />
        </Box>
      ),
    });

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const config = await loadWorkspaceConfigNoCwd(workspace.path);
      const agents = processAgentsFromConfig(config);

      // Remove loading entry and add agents table
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });
      addOutputEntry({
        id: `agents-table-${Date.now()}`,
        component: <AgentListComponent agents={agents} workspaceName={workspace.name} />,
      });
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            Error loading agents: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    } finally {
      setLoadingAgents(false);
    }
  };

  // Handle workspace selection for library
  const handleWorkspaceSelectForLibrary = async (workspaceId: string) => {
    setShowLibraryWorkspaceSelection(false);
    setLoadingLibrary(true);

    // Add loading entry
    addOutputEntry({
      id: `loading-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Loading library items..." />
        </Box>
      ),
    });

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const result = await fetchLibraryItems({
        workspace: workspace.path,
        port: 8080,
      });

      // Remove loading entry
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });

      if (!result.success) {
        // Show non-error message for API failures
        const errorResult = result as { error: string };
        addOutputEntry({
          id: `library-unavailable-${Date.now()}`,
          component: (
            <Text dimColor>
              Cannot fetch library items: {errorResult.error}
            </Text>
          ),
        });
      } else {
        addOutputEntry({
          id: `library-table-${Date.now()}`,
          component: (
            <LibraryListComponent
              items={result.items}
              workspaceName={workspace.name}
            />
          ),
        });
      }
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text dimColor>
            Cannot fetch library items: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    } finally {
      setLoadingLibrary(false);
    }
  };

  // Unified workspace selection handler
  const handleWorkspaceSelect = async (workspaceId: string) => {
    const context = workspaceSelectionContext;
    setShowWorkspaceSelection(false);
    setShowWorkspacesWorkspaceSelection(false);
    setShowAgentWorkspaceSelection(false);
    setShowSessionsWorkspaceSelection(false);
    setShowLibraryWorkspaceSelection(false);
    setWorkspaceSelectionContext(null);

    switch (context) {
      case "signals-select":
        setCurrentSelectionWorkspace(workspaceId);
        setShowSignalSelection(true);
        break;
      case "agents-select":
        setCurrentSelectionWorkspace(workspaceId);
        setShowAgentSelection(true);
        break;
      case "sessions-select":
        setCurrentSelectionWorkspace(workspaceId);
        setShowSessionSelection(true);
        break;
      case "signals-list":
        await handleWorkspaceSelectForSignalsList(workspaceId);
        break;
      case "agents-list":
        await handleWorkspaceSelectForAgents(workspaceId);
        break;
      case "sessions-list":
        await handleWorkspaceSelectForSessions(workspaceId);
        break;
      case "library":
        await handleWorkspaceSelectForLibrary(workspaceId);
        break;
      case "workspaces":
        await handleWorkspaceSelectForWorkspaces(workspaceId);
        break;
      default:
        // Fallback behavior
        break;
    }
  };

  // Handle signal selection
  const handleSignalSelect = (signalId: string) => {
    setShowSignalSelection(false);
    setCurrentSelectionWorkspace(null);
    addOutputEntry({
      id: `signal-selected-${Date.now()}`,
      component: <Text>Selected signal: {signalId}</Text>,
    });
  };

  // Handle session selection
  const handleSessionSelect = (sessionId: string) => {
    setShowSessionSelection(false);
    setCurrentSelectionWorkspace(null);
    addOutputEntry({
      id: `session-selected-${Date.now()}`,
      component: <Text>Selected session: {sessionId}</Text>,
    });
  };

  // Handle agent selection
  const handleAgentSelect = (agentId: string) => {
    setShowAgentSelection(false);
    setCurrentSelectionWorkspace(null);
    addOutputEntry({
      id: `agent-selected-${Date.now()}`,
      component: <Text>Selected agent: {agentId}</Text>,
    });
  };

  // Handle workspace selection for sessions
  const handleWorkspaceSelectForSessions = async (workspaceId: string) => {
    setShowSessionsWorkspaceSelection(false);
    setLoadingSessions(true);

    // Add loading entry
    addOutputEntry({
      id: `loading-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Loading sessions..." />
        </Box>
      ),
    });

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const result = await fetchSessions({
        workspace: workspace.name,
        port: 8080,
      });

      // Remove loading entry
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });

      if (!result.success) {
        // Show non-error message for API failures
        const errorResult = result as { error: string };
        addOutputEntry({
          id: `sessions-unavailable-${Date.now()}`,
          component: <Text dimColor>Cannot fetch sessions: {errorResult.error}</Text>,
        });
      } else {
        addOutputEntry({
          id: `sessions-table-${Date.now()}`,
          component: (
            <SessionListComponent
              sessions={result.filteredSessions}
              workspaceName={workspace.name}
            />
          ),
        });
      }
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text dimColor>
            Cannot fetch sessions: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    } finally {
      setLoadingSessions(false);
    }
  };

  // Command execution handler
  const handleCommand = (input: string) => {
    // Parse command
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      // Non-slash commands show error
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text>
            Commands must start with /. Type /help for available commands.
          </Text>
        ),
      });
      return;
    }

    // Special handling for certain commands
    if (parsed.command === "exit" || parsed.command === "quit") {
      exit();
      return;
    }

    if (parsed.command === "help") {
      setView("help");
      return;
    }

    if (parsed.command === "init") {
      setView("init");
      return;
    }

    if (parsed.command === "credits") {
      setView("credits");
      return;
    }

    if (parsed.command === "workspaces") {
      setWorkspaceSelectionContext("workspaces");
      setShowWorkspacesWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "signal" && parsed.args[0] === "list") {
      setWorkspaceSelectionContext("signals-list");
      setShowWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "signal" && parsed.args.length === 0) {
      setWorkspaceSelectionContext("signals-select");
      setShowWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "agent" && parsed.args[0] === "list") {
      setWorkspaceSelectionContext("agents-list");
      setShowAgentWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "agent" && parsed.args.length === 0) {
      setWorkspaceSelectionContext("agents-select");
      setShowAgentWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "library") {
      setWorkspaceSelectionContext("library");
      setShowLibraryWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "session" && parsed.args[0] === "list") {
      setWorkspaceSelectionContext("sessions-list");
      setShowSessionsWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "session" && parsed.args.length === 0) {
      setWorkspaceSelectionContext("sessions-select");
      setShowSessionsWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "clear") {
      setOutputBuffer([]);
      return;
    }

    // Check command registry
    const commandDef = COMMAND_REGISTRY[parsed.command];
    if (!commandDef) {
      addOutputEntry({
        id: `error-unknown-${Date.now()}`,
        component: (
          <Text color="red">
            Unknown command: /{parsed.command}. Type /help for available commands.
          </Text>
        ),
      });
      return;
    }

    // Execute command handler
    const outputs = commandDef.handler(parsed.args, {
      addEntry: addOutputEntry,
      exit,
    });
    outputs.forEach(addOutputEntry);
  };

  // Enhanced navigation handler
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      padding={1}
      alignItems="flex-start"
      width={dimensions.paddedWidth}
    >
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" alignItems="center">
          <Box flexDirection="column">
            <Text>╭───╮</Text>
            <Text>│&nbsp;∆&nbsp;│</Text>
            <Text>╰───╯</Text>
          </Box>

          <Box flexDirection="column">
            <Text bold>&nbsp;Atlas.&nbsp;</Text>
          </Box>

          <Box flexDirection="column">
            <Text dimColor>Made by Tempest.</Text>
          </Box>
        </Box>

        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>⊕ /help for help</Text>
          <Text dimColor>∶ {Deno.cwd()}</Text>
        </Box>
      </Box>

      {view === "command" && (
        <>
          {/* Output buffer display */}
          {outputBuffer.length > 0 && (
            <Box flexDirection="column" marginY={1} paddingX={1}>
              {outputBuffer.map((entry) => <Box key={entry.id}>{entry.component}</Box>)}
            </Box>
          )}

          {showWorkspacesWorkspaceSelection
            ? (
              <WorkspaceSelection
                onEscape={() => {
                  setShowWorkspacesWorkspaceSelection(false);
                  setWorkspaceSelectionContext(null);
                }}
                onWorkspaceSelect={handleWorkspaceSelect}
              />
            )
            : showWorkspaceSelection
            ? (
              <WorkspaceSelection
                onEscape={() => {
                  setShowWorkspaceSelection(false);
                  setWorkspaceSelectionContext(null);
                }}
                onWorkspaceSelect={handleWorkspaceSelect}
              />
            )
            : showAgentWorkspaceSelection
            ? (
              <WorkspaceSelection
                onEscape={() => {
                  setShowAgentWorkspaceSelection(false);
                  setWorkspaceSelectionContext(null);
                }}
                onWorkspaceSelect={handleWorkspaceSelect}
              />
            )
            : showLibraryWorkspaceSelection
            ? (
              <WorkspaceSelection
                onEscape={() => {
                  setShowLibraryWorkspaceSelection(false);
                  setWorkspaceSelectionContext(null);
                }}
                onWorkspaceSelect={handleWorkspaceSelect}
              />
            )
            : showSessionsWorkspaceSelection
            ? (
              <WorkspaceSelection
                onEscape={() => {
                  setShowSessionsWorkspaceSelection(false);
                  setWorkspaceSelectionContext(null);
                }}
                onWorkspaceSelect={handleWorkspaceSelect}
              />
            )
            : showSignalSelection && currentSelectionWorkspace
            ? (
              <SignalSelection
                workspaceId={currentSelectionWorkspace}
                onEscape={() => {
                  setShowSignalSelection(false);
                  setCurrentSelectionWorkspace(null);
                }}
                onSignalSelect={handleSignalSelect}
              />
            )
            : showSessionSelection && currentSelectionWorkspace
            ? (
              <SessionSelection
                workspaceId={currentSelectionWorkspace}
                onEscape={() => {
                  setShowSessionSelection(false);
                  setCurrentSelectionWorkspace(null);
                }}
                onSessionSelect={handleSessionSelect}
              />
            )
            : showAgentSelection && currentSelectionWorkspace
            ? (
              <AgentSelection
                workspaceId={currentSelectionWorkspace}
                onEscape={() => {
                  setShowAgentSelection(false);
                  setCurrentSelectionWorkspace(null);
                }}
                onAgentSelect={handleAgentSelect}
              />
            )
            : (
              <CommandInput
                onSubmit={handleCommand}
                selectedWorkspace={selectedWorkspace}
              />
            )}
        </>
      )}

      {view === "help" && <Help onExit={() => setView("command")} />}
      {view === "init" && <InitView onExit={() => setView("command")} />}
      {view === "credits" && <CreditsView onExit={() => setView("command")} />}
    </Box>
  );
}
// Command Input Component
interface CommandInputProps {
  onSubmit: (command: string) => void;
  selectedWorkspace?: string | null;
}

const CommandInput = ({ onSubmit, selectedWorkspace }: CommandInputProps) => {
  const [currentInput, setCurrentInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [inputKey, setInputKey] = useState(0);
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => COMMAND_DEFINITIONS;

  // Get all available suggestions (commands only)
  const getAllSuggestions = () => getAllSuggestionsWithDescriptions().map((item) => item.command);

  // Get filtered suggestions based on current input
  const getFilteredSuggestions = () => {
    if (!currentInput.startsWith("/")) return [];

    return getAllSuggestionsWithDescriptions().filter((item) =>
      item.command.toLowerCase().includes(currentInput.toLowerCase())
    );
  };

  // Handle keyboard navigation like SplashScreen
  useInput((input, key) => {
    // When we're in suggestion navigation mode
    if (showSuggestions) {
      if (key.upArrow) {
        const filteredSuggestions = getFilteredSuggestions();
        setSelectedSuggestionIndex((prev) => prev <= 0 ? filteredSuggestions.length - 1 : prev - 1);
        return;
      }
      if (key.downArrow) {
        const filteredSuggestions = getFilteredSuggestions();
        setSelectedSuggestionIndex((prev) => prev >= filteredSuggestions.length - 1 ? 0 : prev + 1);
        return;
      }
      if (key.escape || key.tab) {
        // Go back to input mode

        setSelectedSuggestionIndex(-1);
        return;
      }
      // Any character input goes back to input mode
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setSelectedSuggestionIndex(-1);
        // Let the input be handled by TextInput
        return;
      }
    }
  });

  // Handle input changes from TextInput
  const handleInputChange = (value: string) => {
    setCurrentInput(value);
    setShowSuggestions(value.startsWith("/"));

    if (value.startsWith("/") && selectedSuggestionIndex === -1) {
      setSelectedSuggestionIndex(0);
    }
  };

  // Enhanced submission handler
  const handleSubmit = (command: string) => {
    let commandToSubmit = command.trim();

    // If we have a selected suggestion, use that instead
    if (selectedSuggestionIndex >= 0) {
      const filteredSuggestions = getFilteredSuggestions();
      const selectedSuggestion = filteredSuggestions[selectedSuggestionIndex];
      if (selectedSuggestion) {
        commandToSubmit = selectedSuggestion.command;
      }
    }

    // Always reset input state
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setInputKey((prev) => prev + 1);

    // Submit the command
    onSubmit(commandToSubmit);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>→&nbsp;</Text>
        <TextInput
          key={inputKey}
          suggestions={getAllSuggestions()}
          placeholder="Type / for commands"
          onChange={handleInputChange}
          onSubmit={handleSubmit}
        />
      </Box>

      {/* Always show row with conditional contents */}
      <Box flexDirection="row" justifyContent="space-between">
        {/* Left side: suggestions (always present box) */}
        <Box flexDirection="row" paddingX={2}>
          {showSuggestions && (
            <>
              <Box flexDirection="column" marginRight={1}>
                {getFilteredSuggestions().map((suggestion, index) => (
                  <Text
                    key={suggestion.command}
                    color={index === selectedSuggestionIndex ? "yellow" : ""}
                  >
                    {suggestion.command}
                  </Text>
                ))}
              </Box>
              <Box flexDirection="column" paddingLeft={1}>
                {getFilteredSuggestions().map((suggestion, index) => (
                  <Text
                    key={`${suggestion.command}-desc`}
                    color={index === selectedSuggestionIndex ? "yellow" : ""}
                    dimColor={index !== selectedSuggestionIndex}
                  >
                    {suggestion.description}
                  </Text>
                ))}
              </Box>
            </>
          )}
        </Box>

        {/* Right side: workspace name (always present box) */}
        <Box>
          {selectedWorkspace && <Text color="yellow">{selectedWorkspace}</Text>}
        </Box>
      </Box>
    </Box>
  );
};

// Workspace Selection Component
interface WorkspaceSelectionProps {
  onEscape: () => void;
  onWorkspaceSelect: (workspaceId: string) => void;
}

const WorkspaceSelection = ({
  onEscape,
  onWorkspaceSelect,
}: WorkspaceSelectionProps) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getDaemonClient();
          const workspaceList = await client.listWorkspaces();
          // Convert daemon API format to WorkspaceEntry format for compatibility
          const compatibleWorkspaces = workspaceList.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            configPath: `${w.path}/workspace.yml`, // Standard workspace config path
            status: w.status as WorkspaceStatus,
            createdAt: w.createdAt,
            lastSeen: w.lastSeen,
            metadata: {
              description: w.description,
            },
          }));
          setWorkspaces(compatibleWorkspaces);
        } else {
          setWorkspaces([]);
          setError(
            "Daemon not running. Use 'atlas daemon start' to enable workspace management.",
          );
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadWorkspaces();
  }, []);

  // Handle escape key
  useInput((_input, key) => {
    if (key.escape) {
      onEscape();
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>Loading workspaces...</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      </Box>
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No workspaces found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = workspaces.map((workspace) => ({
    label: `${workspace.name} (${workspace.id})`,
    value: workspace.id,
  }));

  const handleSelect = (value: string) => {
    onWorkspaceSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select options={options} onChange={handleSelect} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
