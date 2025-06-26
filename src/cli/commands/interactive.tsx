import { TextInput } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import Help from "../views/help.tsx";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces",
    );
}

export function handler() {
  render(<InteractiveCommand />);
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
  conversation: ConversationEntry[];
  addEntry: (entry: ConversationEntry) => void;
  exit: () => void;
}

// Command definition interface
interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: (
    args: string[],
    context: CommandContext,
  ) => Promise<ConversationEntry[]>;
}

// Command handlers
const handleHelpCommand = (): Promise<ConversationEntry[]> => {
  const commands = Object.values(COMMAND_REGISTRY);
  const helpEntries = commands.map((cmd) => ({
    id: `help-${cmd.name}`,
    type: "command_output" as const,
    content: `${cmd.usage.padEnd(30)} ${cmd.description}`,
    timestamp: new Date(),
  }));

  return Promise.resolve([
    {
      id: "help-header",
      type: "command_output",
      content: "=== Available Commands ===",
      timestamp: new Date(),
    },
    ...helpEntries,
    {
      id: "help-footer",
      type: "command_output",
      content: "Navigation: j/k to select, Tab to focus input",
      timestamp: new Date(),
    },
  ]);
};

const handleExitCommand = (
  _args: string[],
  context: CommandContext,
): Promise<ConversationEntry[]> => {
  // Add goodbye message before exiting
  setTimeout(() => {
    context.exit();
  }, 500);

  return Promise.resolve([
    {
      id: "exit-message",
      type: "system",
      content: "Goodbye! Shutting down Atlas...",
      timestamp: new Date(),
    },
  ]);
};

const handleListCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const resourceType = args[0] || "all";
  return Promise.resolve([
    {
      id: "list-output",
      type: "command_output",
      content:
        `List command executed - showing ${resourceType} resources (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleInitCommand = (args: string[]): Promise<ConversationEntry[]> => {
  if (args.length === 0) {
    return Promise.resolve([
      {
        id: "init-error",
        type: "error",
        content: "init command requires a workspace name. Usage: /init <workspace-name>",
        timestamp: new Date(),
      },
    ]);
  }

  const workspaceName = args[0];
  return Promise.resolve([
    {
      id: "init-output",
      type: "command_output",
      content: `Initializing workspace: ${workspaceName} (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleSessionCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const subcommand = args[0] || "list";
  return Promise.resolve([
    {
      id: "session-output",
      type: "command_output",
      content: `Session ${subcommand} executed (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleSignalCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const subcommand = args[0] || "list";
  return Promise.resolve([
    {
      id: "signal-output",
      type: "command_output",
      content: `Signal ${subcommand} executed (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleAgentCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const subcommand = args[0] || "list";
  return Promise.resolve([
    {
      id: "agent-output",
      type: "command_output",
      content: `Agent ${subcommand} executed (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleLibraryCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const subcommand = args[0] || "list";
  return Promise.resolve([
    {
      id: "library-output",
      type: "command_output",
      content: `Library ${subcommand} executed (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleConfigCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const subcommand = args[0] || "show";
  return Promise.resolve([
    {
      id: "config-output",
      type: "command_output",
      content: `Config ${subcommand} executed (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

const handleLogsCommand = (args: string[]): Promise<ConversationEntry[]> => {
  const sessionId = args[0];
  if (!sessionId) {
    return Promise.resolve([
      {
        id: "logs-error",
        type: "error",
        content: "logs command requires a session ID. Usage: /logs <session-id>",
        timestamp: new Date(),
      },
    ]);
  }

  return Promise.resolve([
    {
      id: "logs-output",
      type: "command_output",
      content: `Showing logs for session: ${sessionId} (placeholder implementation)`,
      timestamp: new Date(),
    },
  ]);
};

// Command registry
const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
  help: {
    name: "help",
    description: "Show available commands and usage information",
    usage: "/help",
    handler: handleHelpCommand,
  },

  exit: {
    name: "exit",
    description: "Exit the Atlas interactive interface",
    usage: "/exit",
    handler: handleExitCommand,
  },

  workspace: {
    name: "workspace <id>",
    description: "List available workspaces",
    usage: "/workspace <id>",
    handler: handleListCommand,
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

  library: {
    name: "library",
    description: "Access workspace library and templates",
    usage: "/library [list|search] [args...]",
    handler: handleLibraryCommand,
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

// Command validation
const validateCommand = (parsed: ParsedCommand): string | null => {
  const commandDef = COMMAND_REGISTRY[parsed.command];

  if (!commandDef) {
    return `Unknown command: /${parsed.command}`;
  }

  // Add command-specific validation
  switch (parsed.command) {
    case "init":
      if (parsed.args.length === 0) {
        return "init command requires a workspace name. Usage: /init <workspace-name>";
      }
      break;

    case "logs":
      if (parsed.args.length === 0) {
        return "logs command requires a session ID. Usage: /logs <session-id>";
      }
      break;

    case "session":
      if (
        parsed.args.length > 0 &&
        !["list", "get", "kill"].includes(parsed.args[0])
      ) {
        return "session subcommand must be one of: list, get, kill";
      }
      break;

    case "signal":
      if (
        parsed.args.length > 0 &&
        !["list", "trigger", "describe", "test"].includes(parsed.args[0])
      ) {
        return "signal subcommand must be one of: list, trigger, describe, test";
      }
      break;

    case "agent":
      if (
        parsed.args.length > 0 &&
        !["list", "describe", "status", "test"].includes(parsed.args[0])
      ) {
        return "agent subcommand must be one of: list, describe, status, test";
      }
      break;

    case "library":
      if (
        parsed.args.length > 0 &&
        !["list", "search", "templates"].includes(parsed.args[0])
      ) {
        return "library subcommand must be one of: list, search, templates";
      }
      break;

    case "config":
      if (
        parsed.args.length > 0 &&
        !["show", "validate", "create-job"].includes(parsed.args[0])
      ) {
        return "config subcommand must be one of: show, validate, create-job";
      }
      break;
  }

  return null;
};

export default function InteractiveCommand() {
  const [_inputValue, _setInputValue] = useState("");
  const [view, setView] = useState<"help" | "command">("command");
  const [_minHeight, setMinHeight] = useState(35);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Calculate available height for conversation display
  const availableHeight = Math.max(20, (stdout.rows || 24) - 8); // Reserve space for input

  useEffect(() => {
    const requiredHeight = Math.max(35, availableHeight + 8);
    setMinHeight(requiredHeight);
  }, [availableHeight]);

  // Command execution handler
  const handleCommand = (input: string) => {
    if (input === "/exit" || input === "/quit") {
      exit();
    }

    if (input === "/help") {
      setView("help");
      return;
    }
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

      {view === "command" && <CommandInput onSubmit={handleCommand} />}

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
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => [
    {
      command: "/help",
      description: "Show available commands and usage information",
    },
    {
      command: "/list",
      description: "View workspaces, sessions, signals, agents, and library items",
    },
    { command: "/init", description: "Initialize a new workspace" },
    { command: "/sessions", description: "View available workspace sessions" },
    {
      command: "/signals",
      description: "View available workspace signals",
    },
    { command: "/agents", description: "View workspace agents" },
    {
      command: "/library",
      description: "View available workspace artifacts",
    },
    { command: "/config", description: "Atlas configuration settings" },
    { command: "/logs", description: "View workspace logs" },
    { command: "/exit", description: "Exit the Atlas interactive interface" },
  ];

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

    if (selectedSuggestionIndex === -1) {
      setSelectedSuggestionIndex(0);
    }
  };

  // Enhanced submission handler with validation
  const handleSubmit = (command: string) => {
    const trimmedCommand = command.trim();

    // Reset input and suggestions
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);

    // Validate command before submission
    const parsed = parseSlashCommand(trimmedCommand);
    if (parsed) {
      const validationError = validateCommand(parsed);
      if (validationError) {
        return;
      }
    }

    // Command is valid, submit it
    onSubmit(trimmedCommand);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>→</Text>
        <TextInput
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
