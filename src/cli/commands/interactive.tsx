import { Select, TextInput, ThemeProvider, extendTheme, defaultTheme, Spinner } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import Help from "../views/help.tsx";
import { Newline } from "../views/Newline.tsx";
import { WorkspaceList } from "../views/WorkspaceList.tsx";
import { getWorkspaceRegistry } from "../../core/workspace-registry.ts";
import { WorkspaceEntry } from "../../core/workspace-registry-types.ts";
import { SignalListComponent } from "../modules/signals/SignalListComponent.tsx";
import { AgentListComponent } from "../modules/agents/agent-list-component.tsx";
import { processAgentsFromConfig } from "../modules/agents/processor.ts";
import { LibraryListComponent } from "../modules/library/library-list-component.tsx";
import { fetchLibraryItems } from "../modules/library/fetcher.ts";
import { loadWorkspaceConfigNoCwd } from "../modules/workspaces/resolver.ts";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces"
    );
}

// Custom theme with yellow highlights for Select components  
const customTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: 'yellow' }),
        label: ({isFocused, isSelected}) => ({
          color: isSelected ? 'yellow' : isFocused ? 'yellow' : undefined
        })
      }
    }
  }
});

export function handler() {
  render(
    <ThemeProvider theme={customTheme}>
      <InteractiveCommand />
    </ThemeProvider>
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

const handleWorkspacesCommand = (): OutputEntry[] => {
  // This returns empty because parent component handles it directly
  return [];
};

const handleSignalsCommand = (args: string[], context: CommandContext): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `signals-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its signals:</Text>
  });
  return [];
};

const handleAgentsCommand = (args: string[], context: CommandContext): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `agents-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its agents:</Text>
  });
  return [];
};

const handleLibraryCommand = (args: string[], context: CommandContext): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `library-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its library:</Text>
  });
  return [];
};

const handleInitCommand = (args: string[]): OutputEntry[] => {
  if (args.length === 0) {
    return [
      {
        id: `init-error-${Date.now()}`,
        component: (
          <Text color="red">
            init command requires a workspace name. Usage: /init
            &lt;workspace-name&gt;
          </Text>
        ),
      },
    ];
  }

  const workspaceName = args[0];
  return [
    {
      id: `init-output-${Date.now()}`,
      component: (
        <Text>
          Initializing workspace: {workspaceName} (placeholder implementation)
        </Text>
      ),
    },
  ];
};

const handleSessionCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `session-output-${Date.now()}`,
      component: (
        <Text>Session {subcommand} executed (placeholder implementation)</Text>
      ),
    },
  ];
};

const handleSignalCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `signal-output-${Date.now()}`,
      component: (
        <Text>Signal {subcommand} executed (placeholder implementation)</Text>
      ),
    },
  ];
};

const handleAgentCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "list";
  return [
    {
      id: `agent-output-${Date.now()}`,
      component: (
        <Text>Agent {subcommand} executed (placeholder implementation)</Text>
      ),
    },
  ];
};


const handleConfigCommand = (args: string[]): OutputEntry[] => {
  const subcommand = args[0] || "show";
  return [
    {
      id: `config-output-${Date.now()}`,
      component: (
        <Text>Config {subcommand} executed (placeholder implementation)</Text>
      ),
    },
  ];
};

const handleLogsCommand = (args: string[]): OutputEntry[] => {
  const sessionId = args[0];
  if (!sessionId) {
    return [
      {
        id: `logs-error-${Date.now()}`,
        component: (
          <Text color="red">
            logs command requires a session ID. Usage: /logs &lt;session-id&gt;
          </Text>
        ),
      },
    ];
  }

  return [
    {
      id: `logs-output-${Date.now()}`,
      component: (
        <Text>
          Showing logs for session: {sessionId} (placeholder implementation)
        </Text>
      ),
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

  signals: {
    name: "signals",
    description: "View workspace signals",
    usage: "/signals",
    handler: handleSignalsCommand,
  },

  agents: {
    name: "agents",
    description: "View workspace agents",
    usage: "/agents",
    handler: handleAgentsCommand,
  },

  library: {
    name: "library",
    description: "View workspace library",
    usage: "/library",
    handler: handleLibraryCommand,
  },

  init: {
    name: "init",
    description: "Initialize a new workspace",
    usage: "/init <workspace-name>",
    handler: handleInitCommand,
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

  logs: {
    name: "logs",
    description: "View session logs and output",
    usage: "/logs <session-id>",
    handler: handleLogsCommand,
  },
};

// Output buffer entry that can hold different component types
interface OutputEntry {
  id: string;
  component: React.ReactElement;
}


export default function InteractiveCommand() {
  const [_inputValue, _setInputValue] = useState("");
  const [view, setView] = useState<"help" | "command">("command");
  const [_minHeight, setMinHeight] = useState(35);
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const [showWorkspaceSelection, setShowWorkspaceSelection] = useState(false);
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [showAgentWorkspaceSelection, setShowAgentWorkspaceSelection] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [showLibraryWorkspaceSelection, setShowLibraryWorkspaceSelection] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
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

  // Handle workspace selection for signals
  const handleWorkspaceSelect = async (workspaceId: string) => {
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
      const workspace = await getWorkspaceRegistry().findById(workspaceId);
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
        component: <SignalListComponent signalEntries={signalEntries} workspaceName={workspace.name} />,
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
      const workspace = await getWorkspaceRegistry().findById(workspaceId);
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
      const workspace = await getWorkspaceRegistry().findById(workspaceId);
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
        addOutputEntry({
          id: `library-unavailable-${Date.now()}`,
          component: (
            <Text dimColor>
              Cannot fetch library items: {result.error}
            </Text>
          ),
        });
      } else {
        addOutputEntry({
          id: `library-table-${Date.now()}`,
          component: <LibraryListComponent items={result.items} workspaceName={workspace.name} />,
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

    if (parsed.command === "workspaces") {
      // Add components to output buffer
      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });
      addOutputEntry({
        id: `workspaces-header-${Date.now()}`,
        component: <Text>Here are the available Workspaces in Atlas</Text>,
      });
      addOutputEntry({
        id: `spacer-${Date.now()}-2`,
        component: <Newline />,
      });
      addOutputEntry({
        id: `workspaces-component-${Date.now()}`,
        component: <WorkspaceList />,
      });
      return;
    }

    if (parsed.command === "signals") {
      setShowWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "agents") {
      setShowAgentWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "library") {
      setShowLibraryWorkspaceSelection(true);
      return;
    }

    // Check command registry
    const commandDef = COMMAND_REGISTRY[parsed.command];
    if (!commandDef) {
      addOutputEntry({
        id: `error-unknown-${Date.now()}`,
        component: (
          <Text color="red">
            Unknown command: /{parsed.command}. Type /help for available
            commands.
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

      {view === "command" && (
        <>
          {/* Output buffer display */}
          {outputBuffer.length > 0 && (
            <Box flexDirection="column" marginY={1}>
              {outputBuffer.map((entry) => (
                <Box key={entry.id}>{entry.component}</Box>
              ))}
            </Box>
          )}
          {showWorkspaceSelection ? (
            <WorkspaceSelection 
              onEscape={() => setShowWorkspaceSelection(false)} 
              onWorkspaceSelect={handleWorkspaceSelect}
            />
          ) : showAgentWorkspaceSelection ? (
            <WorkspaceSelection 
              onEscape={() => setShowAgentWorkspaceSelection(false)} 
              onWorkspaceSelect={handleWorkspaceSelectForAgents}
            />
          ) : showLibraryWorkspaceSelection ? (
            <WorkspaceSelection 
              onEscape={() => setShowLibraryWorkspaceSelection(false)} 
              onWorkspaceSelect={handleWorkspaceSelectForLibrary}
            />
          ) : (
            <CommandInput onSubmit={handleCommand} />
          )}
        </>
      )}

      {view === "help" && <Help onExit={() => setView("command")} />}
    </Box>
  );
}
// Command Input Component
interface CommandInputProps {
  onSubmit: (command: string) => void;
}

const CommandInput = ({ onSubmit }: CommandInputProps) => {
  const [currentInput, setCurrentInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [inputKey, setInputKey] = useState(0);
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => [
    {
      command: "/help",
      description: "Show available commands and usage information",
    },
    {
      command: "/workspaces",
      description: "View available workspaces",
    },
    { command: "/init", description: "Initialize a new workspace" },
    { command: "/sessions", description: "View available workspace sessions" },
    {
      command: "/signals",
      description: "View available workspace signals",
    },
    {
      command: "/agents", 
      description: "View workspace agents"
    },
    {
      command: "/library",
      description: "View workspace library"
    },
    { command: "/config", description: "Atlas configuration settings" },
    { command: "/logs", description: "View workspace logs" },
    { command: "/exit", description: "Exit the Atlas interactive interface" },
  ];

  // Get all available suggestions (commands only)
  const getAllSuggestions = () =>
    getAllSuggestionsWithDescriptions().map((item) => item.command);

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
        setSelectedSuggestionIndex((prev) =>
          prev <= 0 ? filteredSuggestions.length - 1 : prev - 1
        );
        return;
      }
      if (key.downArrow) {
        const filteredSuggestions = getFilteredSuggestions();
        setSelectedSuggestionIndex((prev) =>
          prev >= filteredSuggestions.length - 1 ? 0 : prev + 1
        );
        return;
      }
      if (key.return && selectedSuggestionIndex >= 0) {
        // Accept selected suggestion
        const filteredSuggestions = getFilteredSuggestions();
        const selectedSuggestion = filteredSuggestions[selectedSuggestionIndex];
        setCurrentInput(selectedSuggestion.command);
        setShowSuggestions(false);
        setSelectedSuggestionIndex(-1);

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
    const trimmedCommand = command.trim();

    // Always reset input state
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setInputKey((prev) => prev + 1);

    // Submit the command
    onSubmit(trimmedCommand);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>→ </Text>
        <TextInput
          key={inputKey}
          suggestions={getAllSuggestions()}
          placeholder="Type / for commands"
          onChange={handleInputChange}
          onSubmit={handleSubmit}
        />
      </Box>

      {/* Show suggestions below */}
      {showSuggestions && (
        <Box flexDirection="row" marginTop={1} paddingX={2}>
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
        </Box>
      )}
    </Box>
  );
};

// Workspace Selection Component
interface WorkspaceSelectionProps {
  onEscape: () => void;
  onWorkspaceSelect: (workspaceId: string) => void;
}

const WorkspaceSelection = ({ onEscape, onWorkspaceSelect }: WorkspaceSelectionProps) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        const registry = getWorkspaceRegistry();
        await registry.initialize();
        const workspaceList = await registry.listAll();
        setWorkspaces(workspaceList);
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
  useInput((input, key) => {
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
        <Select
          options={options}
          onChange={handleSelect}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};

