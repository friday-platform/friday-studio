import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { TextInput } from "@inkjs/ui";

interface ConversationEntry {
  id: string;
  type: "user" | "system" | "command_output" | "error" | "intro";
  content: string;
  timestamp: Date;
}

interface ConversationalState {
  entries: ConversationEntry[];
  currentInput: string;
  selectedEntryIndex: number;
  inputFocused: boolean;
}

// Introduction messages that appear when the UI starts
const INTRODUCTION_MESSAGES: ConversationEntry[] = [
  {
    id: "intro-1",
    type: "intro",
    content: "Welcome to Atlas - AI Agent Orchestration Platform",
    timestamp: new Date(),
  },
  {
    id: "intro-2",
    type: "intro",
    content: "Type /help to see available commands. All commands must start with /",
    timestamp: new Date(),
  },
  {
    id: "intro-3",
    type: "system",
    content: "Atlas is ready. What would you like to do?",
    timestamp: new Date(),
  },
];

import { render } from "ink";
import { YargsInstance } from "../utils/yargs.ts";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces",
    );
}

export async function handler() {
  render(<InteractiveCommand />);
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

  list: {
    name: "list",
    description: "List available resources (workspaces, sessions, etc.)",
    usage: "/list [resource_type]",
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

function InteractiveCommand() {
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [_inputValue, _setInputValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(true);
  const [minHeight, setMinHeight] = useState(35);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const { stdout } = useStdout();
  const { exit } = useApp();

  // Initialize with introduction messages
  useEffect(() => {
    setConversation(INTRODUCTION_MESSAGES);
  }, []);

  // Calculate available height for conversation display
  const availableHeight = Math.max(20, (stdout.rows || 24) - 8); // Reserve space for input

  useEffect(() => {
    const requiredHeight = Math.max(35, availableHeight + 8);
    setMinHeight(requiredHeight);
  }, [availableHeight]);

  // Add conversation entry helper
  const addConversationEntry = (entry: ConversationEntry) => {
    setConversation((prev) => [...prev, entry]);
  };

  // Command execution handler
  const handleCommand = async (input: string) => {
    // Add to command history (avoid duplicates and limit to last 50 commands)
    setCommandHistory((prev) => {
      const filtered = prev.filter((cmd) => cmd !== input);
      const updated = [...filtered, input];
      return updated.slice(-50); // Keep last 50 commands
    });

    // Add user input to conversation
    const userEntry: ConversationEntry = {
      id: `user-${Date.now()}`,
      type: "user",
      content: input,
      timestamp: new Date(),
    };

    addConversationEntry(userEntry);

    // Parse command
    const parsed = parseSlashCommand(input);

    if (!parsed) {
      // Handle non-slash input
      const errorEntry: ConversationEntry = {
        id: `error-${Date.now()}`,
        type: "error",
        content: "Commands must start with /. Type /help for available commands.",
        timestamp: new Date(),
      };
      addConversationEntry(errorEntry);
      return;
    }

    // Execute command
    const commandDef = COMMAND_REGISTRY[parsed.command];

    if (!commandDef) {
      const errorEntry: ConversationEntry = {
        id: `error-${Date.now()}`,
        type: "error",
        content: `Unknown command: /${parsed.command}. Type /help for available commands.`,
        timestamp: new Date(),
      };
      addConversationEntry(errorEntry);
      return;
    }

    try {
      // Validate command arguments
      const validationError = validateCommand(parsed);
      if (validationError) {
        const errorEntry: ConversationEntry = {
          id: `validation-error-${Date.now()}`,
          type: "error",
          content: validationError,
          timestamp: new Date(),
        };
        addConversationEntry(errorEntry);
        return;
      }

      const outputEntries = await commandDef.handler(parsed.args, {
        conversation,
        addEntry: addConversationEntry,
        exit,
      });
      outputEntries.forEach((entry) => addConversationEntry(entry));
    } catch (error) {
      const errorEntry: ConversationEntry = {
        id: `error-${Date.now()}`,
        type: "error",
        content: `Command failed: ${error.message}`,
        timestamp: new Date(),
      };
      addConversationEntry(errorEntry);
    }
  };

  // Enhanced navigation handler
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }

    // Tab key focuses input and clears selection
    if (key.tab && !inputFocused) {
      setInputFocused(true);
      setSelectedIndex(-1);
      return;
    }

    // Enter key actions when entry is selected
    if (key.return && !inputFocused && selectedIndex >= 0) {
      const selectedEntry = conversation[selectedIndex];
      if (
        selectedEntry &&
        selectedEntry.type === "user" &&
        selectedEntry.content.startsWith("/")
      ) {
        // Add the command to history so it appears in suggestions
        setCommandHistory((prev) => {
          const filtered = prev.filter((cmd) => cmd !== selectedEntry.content);
          const updated = [...filtered, selectedEntry.content];
          return updated.slice(-50);
        });

        // Add a system message showing what was copied
        const copyEntry: ConversationEntry = {
          id: `copy-${Date.now()}`,
          type: "system",
          content:
            `Command "${selectedEntry.content}" added to suggestions. Focus input and check suggestions.`,
          timestamp: new Date(),
        };
        addConversationEntry(copyEntry);

        // Focus input and clear selection
        setInputFocused(true);
        setSelectedIndex(-1);
      }
      return;
    }

    // Vim-style navigation shortcuts
    if (!inputFocused && conversation.length > 0) {
      // 'g' then 'g' to go to top
      if (inputChar === "g") {
        // Simple approach: just go to top on single 'g' for now
        setSelectedIndex(0);
        return;
      }

      // 'G' (Shift+g) to go to bottom
      if (inputChar === "G") {
        setSelectedIndex(conversation.length - 1);
        return;
      }
    }

    // Basic j/k navigation (up/down arrows or j/k keys)
    if (
      (key.upArrow || (inputChar === "k" && !inputFocused)) &&
      conversation.length > 0
    ) {
      setInputFocused(false);
      setSelectedIndex((prev) => {
        if (prev === -1) {
          // First navigation - start from bottom
          return conversation.length - 1;
        }
        return Math.max(0, prev - 1);
      });
    } else if (
      (key.downArrow || (inputChar === "j" && !inputFocused)) &&
      conversation.length > 0
    ) {
      setInputFocused(false);
      setSelectedIndex((prev) => {
        if (prev === -1) {
          // First navigation - start from top
          return 0;
        }
        return Math.min(conversation.length - 1, prev + 1);
      });
    }

    // Page up/down navigation (Ctrl+U/Ctrl+D or PageUp/PageDown)
    if ((key.ctrl && inputChar === "u") || key.pageUp) {
      if (!inputFocused && conversation.length > 0) {
        const pageSize = Math.max(1, Math.floor(availableHeight / 2));
        setSelectedIndex((prev) => {
          const newIndex = prev === -1 ? conversation.length - 1 : Math.max(0, prev - pageSize);
          return newIndex;
        });
        setInputFocused(false);
      }
    } else if ((key.ctrl && inputChar === "d") || key.pageDown) {
      if (!inputFocused && conversation.length > 0) {
        const pageSize = Math.max(1, Math.floor(availableHeight / 2));
        setSelectedIndex((prev) => {
          const newIndex = prev === -1 ? 0 : Math.min(conversation.length - 1, prev + pageSize);
          return newIndex;
        });
        setInputFocused(false);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row" alignItems="center">
        <Box flexDirection="column">
          <Text>╭───╮</Text>
          <Text>│&nbsp;Δ&nbsp;│</Text>
          <Text>╰───╯</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Atlas.</Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>Made by Tempest.</Text>
        </Box>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>φ /help for help</Text>
        <Text dimColor>↬ cwd: {Deno.cwd()}</Text>
      </Box>

      <CommandInput
        onSubmit={handleCommand}
        focused={inputFocused}
        setFocused={setInputFocused}
        commandHistory={commandHistory}
      />
    </Box>
  );
}

// Conversational UI Component
interface ConversationalUIProps {
  conversation: ConversationEntry[];
  onCommand: (command: string) => void;
  selectedIndex: number;
  inputFocused: boolean;
  availableHeight: number;
  commandHistory: string[];
}

const ConversationalUI = ({
  conversation,
  onCommand,
  selectedIndex,
  inputFocused,
  availableHeight,
  commandHistory,
}: ConversationalUIProps) => {
  return (
    <Box flexDirection="column" height="100%">
      <ConversationHistory
        entries={conversation}
        selectedIndex={selectedIndex}
        maxHeight={availableHeight - 8} // Reserve more space for enhanced input
      />
      <CommandInput
        onSubmit={onCommand}
        focused={inputFocused}
        commandHistory={commandHistory}
      />
      <StatusBar
        conversationLength={conversation.length}
        selectedIndex={selectedIndex}
        inputFocused={inputFocused}
        commandHistoryLength={commandHistory.length}
      />
    </Box>
  );
};

// Status Bar Component
interface StatusBarProps {
  conversationLength: number;
  selectedIndex: number;
  inputFocused: boolean;
  commandHistoryLength?: number;
}

const StatusBar = ({
  conversationLength,
  selectedIndex,
  inputFocused,
  commandHistoryLength = 0,
}: StatusBarProps) => {
  const getStatusText = () => {
    if (inputFocused) {
      return `Input focused • ${commandHistoryLength} commands in history • Smart suggestions enabled`;
    } else if (selectedIndex >= 0) {
      return `Entry ${
        selectedIndex + 1
      }/${conversationLength} selected • Enter to add to suggestions • Tab to focus input`;
    } else {
      return `${conversationLength} entries • j/k to navigate • Tab to focus input • g/G for top/bottom`;
    }
  };

  return (
    <Box borderTop borderColor="gray" paddingTop={1} paddingX={1}>
      <Text color="gray" dimColor>
        {getStatusText()}
      </Text>
    </Box>
  );
};

// Conversation History Component
interface ConversationHistoryProps {
  entries: ConversationEntry[];
  selectedIndex: number;
  maxHeight: number;
}

const ConversationHistory = ({
  entries,
  selectedIndex,
  maxHeight,
}: ConversationHistoryProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new entries are added (only if auto-scroll is enabled)
  useEffect(() => {
    if (autoScroll && entries.length > maxHeight) {
      setScrollOffset(entries.length - maxHeight);
    }
  }, [entries.length, maxHeight, autoScroll]);

  // Handle selection scrolling - ensure selected entry is visible
  useEffect(() => {
    if (selectedIndex >= 0) {
      // Disable auto-scroll when user is navigating manually
      setAutoScroll(false);

      // Scroll to make selected entry visible
      if (selectedIndex < scrollOffset) {
        // Selected entry is above visible area
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + maxHeight) {
        // Selected entry is below visible area
        setScrollOffset(selectedIndex - maxHeight + 1);
      }
    }
  }, [selectedIndex, scrollOffset, maxHeight]);

  // Re-enable auto-scroll when selection is cleared (user focuses input)
  useEffect(() => {
    if (selectedIndex === -1) {
      setAutoScroll(true);
    }
  }, [selectedIndex]);

  const visibleEntries = entries.slice(scrollOffset, scrollOffset + maxHeight);

  return (
    <Box
      flexDirection="column"
      height={maxHeight}
      overflow="hidden"
      marginBottom={1}
    >
      {/* Show scroll indicator if there are more entries above */}
      {scrollOffset > 0 && (
        <Box justifyContent="center">
          <Text color="gray" dimColor>
            ▲ {scrollOffset} more entries above ▲
          </Text>
        </Box>
      )}

      {visibleEntries.map((entry, index) => (
        <ConversationEntry
          key={entry.id}
          entry={entry}
          isSelected={selectedIndex === index + scrollOffset}
          globalIndex={index + scrollOffset}
          totalEntries={entries.length}
        />
      ))}

      {/* Show scroll indicator if there are more entries below */}
      {scrollOffset + maxHeight < entries.length && (
        <Box justifyContent="center">
          <Text color="gray" dimColor>
            ▼ {entries.length - (scrollOffset + maxHeight)} more entries below ▼
          </Text>
        </Box>
      )}

      {/* Show conversation summary at the bottom */}
      {entries.length > 0 && (
        <Box marginTop={1} paddingX={2}>
          <Text color="gray" dimColor>
            Conversation: {entries.filter((e) => e.type === "user").length} commands •{" "}
            {entries.filter((e) => e.type === "command_output").length} responses •{" "}
            {entries.filter((e) => e.type === "error").length} errors
          </Text>
        </Box>
      )}
    </Box>
  );
};

// Individual Entry Component
interface ConversationEntryProps {
  entry: ConversationEntry;
  isSelected: boolean;
  globalIndex: number;
  totalEntries: number;
}

const ConversationEntry = ({
  entry,
  isSelected,
  globalIndex,
  totalEntries,
}: ConversationEntryProps) => {
  const getEntryColor = (type: ConversationEntry["type"]) => {
    switch (type) {
      case "user":
        return "cyan";
      case "system":
        return "green";
      case "command_output":
        return "white";
      case "error":
        return "red";
      case "intro":
        return "yellow";
      default:
        return "white";
    }
  };

  const getEntryIcon = (type: ConversationEntry["type"]) => {
    switch (type) {
      case "user":
        return ">";
      case "system":
        return "●";
      case "command_output":
        return "→";
      case "error":
        return "✗";
      case "intro":
        return "★";
      default:
        return "•";
    }
  };

  const timestamp = entry.timestamp.toTimeString().slice(0, 8);
  const entryNumber = globalIndex + 1;

  return (
    <Box>
      <Text
        color={isSelected ? "black" : getEntryColor(entry.type)}
        backgroundColor={isSelected ? "white" : undefined}
        wrap="wrap"
      >
        {isSelected ? `▶ [${entryNumber}/${totalEntries}] ` : `  ${getEntryIcon(entry.type)} `}
        <Text color={isSelected ? "black" : "gray"}>[{timestamp}]</Text>
        <Text color={isSelected ? "black" : getEntryColor(entry.type)}>
          {entry.content}
        </Text>
        {isSelected &&
          entry.type === "user" &&
          entry.content.startsWith("/") && (
          <Text color={isSelected ? "black" : "gray"}>
            [Press Enter to copy command]
          </Text>
        )}
        {isSelected &&
          entry.type === "command_output" &&
          entry.content.includes("placeholder") && (
          <Text color={isSelected ? "black" : "gray"}>
            [Placeholder response]
          </Text>
        )}
      </Text>
    </Box>
  );
};

// Command Input Component
interface CommandInputProps {
  onSubmit: (command: string) => void;
  focused: boolean;
  setFocused: (focused: boolean) => void;
  commandHistory: string[];
}

const CommandInput = ({
  onSubmit,
  focused,
  setFocused,
  commandHistory,
}: CommandInputProps) => {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const [isValid, setIsValid] = useState(true);
  const [currentInput, setCurrentInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => [
    {
      command: "/help",
      description: "Show available commands and usage information",
    },
    {
      command: "/list",
      description: "List available resources (workspaces, sessions, etc.)",
    },
    { command: "/init", description: "Initialize a new workspace" },
    { command: "/session list", description: "List active workspace sessions" },
    {
      command: "/signal list",
      description: "List configured workspace signals",
    },
    { command: "/agent list", description: "List workspace agents" },
    {
      command: "/library list",
      description: "Access workspace library and templates",
    },
    { command: "/config show", description: "View workspace configuration" },
    { command: "/logs", description: "View session logs and output" },
    { command: "/exit", description: "Exit the Atlas interactive interface" },
    ...commandHistory
      .slice(-5)
      .map((cmd) => ({ command: cmd, description: "Recent command" })),
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
    // When suggestions are visible and we're in input mode
    if (showSuggestions && focused) {
      if (key.downArrow) {
        // Switch to suggestion navigation mode
        setFocused(false);
        setSelectedSuggestionIndex(0);
        return;
      }
    }

    // When we're in suggestion navigation mode
    if (showSuggestions && !focused) {
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
        setFocused(true);
        return;
      }
      if (key.escape || key.tab) {
        // Go back to input mode
        setFocused(true);
        setSelectedSuggestionIndex(-1);
        return;
      }
      // Any character input goes back to input mode
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setFocused(true);
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
  };

  // Enhanced submission handler with validation
  const handleSubmit = (command: string) => {
    const trimmedCommand = command.trim();

    // Reset input and suggestions
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setFocused(true);

    if (!trimmedCommand) {
      setValidationMessage("Please enter a command");
      setIsValid(false);
      return;
    }

    if (!trimmedCommand.startsWith("/")) {
      setValidationMessage("Commands must start with /");
      setIsValid(false);
      return;
    }

    // Validate command before submission
    const parsed = parseSlashCommand(trimmedCommand);
    if (parsed) {
      const validationError = validateCommand(parsed);
      if (validationError) {
        setValidationMessage(validationError);
        setIsValid(false);
        return;
      }
    }

    // Command is valid, submit it
    setValidationMessage(null);
    setIsValid(true);
    onSubmit(trimmedCommand);
  };

  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>⋗</Text>
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
