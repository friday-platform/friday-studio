import {
  defaultTheme,
  extendTheme,
  Select,
  Spinner,
  ThemeProvider,
  UnorderedList,
} from "@inkjs/ui";
import { Box, Newline, render, Static, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import Help from "../views/help.tsx";
import { InitView } from "../views/InitView.tsx";
import { ConfigView } from "../views/ConfigView.tsx";
import CreditsView from "../views/CreditsView.tsx";
import { getDaemonClient } from "../utils/daemon-client.ts";
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
import { JobSelection } from "../components/job-selection.tsx";
import { SignalDetails } from "../components/signal-details.tsx";
import { SignalActionSelection } from "../components/signal-action-selection.tsx";
import { SignalTriggerInput } from "../components/signal-trigger-input.tsx";
import { triggerSignalSimple } from "../modules/signals/trigger.ts";
import { AgentDetails } from "../components/agent-details.tsx";
import { JobDetails } from "../components/job-details.tsx";
import { SessionDetails } from "../components/session-details.tsx";
import { formatVersionDisplay, getVersionInfo } from "../../utils/version.ts";
import { TextInput } from "../components/text-input/text-input.tsx";
import { COMMAND_DEFINITIONS } from "../utils/command-definitions.ts";
import { getAtlasClient } from "@atlas/client";
import { createTempFileAndOpen } from "../utils/file-opener.ts";
import { ConversationClient } from "../utils/conversation-client.ts";
import { ChatMessage } from "../components/ChatMessage.tsx";
import { YamlDisplay } from "../components/yaml-display.tsx";
import { GitDiff } from "../components/git-diff.tsx";
import { AppProvider, useAppContext } from "../contexts/app-context.tsx";
import { CommandInput } from "../components/command-input.tsx";

// Wrapper component that fetches workspace path via client
const SignalDetailsWithPath = ({
  workspaceId,
  signalId,
}: {
  workspaceId: string;
  signalId: string;
}) => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchWorkspacePath = async () => {
      try {
        const client = getAtlasClient();
        const workspacePath = await client.getWorkspacePath(workspaceId);
        setWorkspacePath(workspacePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchWorkspacePath();
  }, [workspaceId]);

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading workspace information...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!workspacePath) {
    return (
      <Box>
        <Text color="red">Workspace path not found</Text>
      </Box>
    );
  }

  return (
    <SignalDetails
      workspaceId={workspaceId}
      signalId={signalId}
      workspacePath={workspacePath}
    />
  );
};

// Wrapper component that fetches workspace path for job details
const JobDetailsWithPath = ({
  workspaceId,
  jobName,
}: {
  workspaceId: string;
  jobName: string;
}) => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchWorkspacePath = async () => {
      try {
        const client = getAtlasClient();
        const workspacePath = await client.getWorkspacePath(workspaceId);
        setWorkspacePath(workspacePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchWorkspacePath();
  }, [workspaceId]);

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading workspace information...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!workspacePath) {
    return (
      <Box>
        <Text color="red">Workspace path not found</Text>
      </Box>
    );
  }

  return (
    <JobDetails
      workspaceId={workspaceId}
      jobName={jobName}
      workspacePath={workspacePath}
    />
  );
};

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces",
    );
}

// Helper function to get workspace by ID using daemon API
const getWorkspaceById = async (workspaceId: string) => {
  try {
    const client = getDaemonClient();
    return await client.getWorkspace(workspaceId);
  } catch (error) {
    console.warn("Failed to get workspace:", error);
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

const handleConfigCommand = (_args: string[]): OutputEntry[] => {
  // Config command switches to its own view, no output entries needed
  return [];
};

const handleStatusCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Perform async health check
  const checkDaemonStatus = async () => {
    try {
      // Use getAtlasClient for consistent behavior, but with a short timeout
      const client = getAtlasClient({ timeout: 1000 }); // 1 second timeout for status check
      const isHealthy = await client.isHealthy();

      if (isHealthy) {
        context.addEntry({
          id: `status-success-${Date.now()}`,
          component: (
            <Box paddingLeft={1}>
              <Text color="green">✓ Atlas daemon is running</Text>
            </Box>
          ),
        });
      } else {
        context.addEntry({
          id: `status-not-running-${Date.now()}`,
          component: (
            <Box paddingLeft={1}>
              <Text color="yellow">◆ Atlas daemon is not running</Text>
            </Box>
          ),
        });
      }
    } catch (_error) {
      context.addEntry({
        id: `status-error-${Date.now()}`,
        component: (
          <Box paddingLeft={1}>
            <Text color="yellow">◆ Atlas daemon is not running</Text>
          </Box>
        ),
      });
    }
  };

  // Fire and forget async operation
  checkDaemonStatus();

  // Return loading message
  return [
    {
      id: `status-loading-${Date.now()}`,
      component: (
        <Box paddingLeft={1}>
          <Text dimColor>Checking daemon status...</Text>
        </Box>
      ),
    },
  ];
};

/**
 * Handle /library open <item_id> command
 */
const handleLibraryOpenCommand = async (
  itemId: string,
  addOutputEntry: (entry: OutputEntry) => void,
) => {
  try {
    const client = getAtlasClient();

    // Show loading message
    addOutputEntry({
      id: `library-open-loading-${Date.now()}`,
      component: <Text dimColor>Opening library item {itemId}...</Text>,
    });

    // We need to search for the item across all workspaces since we don't have workspace context
    // First try to get the item directly from global library
    let libraryItem;
    try {
      libraryItem = await client.getLibraryItem(itemId, true);
    } catch (error) {
      // If global library doesn't work, we'd need workspace-specific search
      // For now, show an error about needing workspace context
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: (
          <Text color="red">
            Could not find library item '{itemId}'. Library items may be workspace-specific.
            {error instanceof Error ? ` Error: ${error.message}` : ""}
          </Text>
        ),
      });
      return;
    }

    if (!libraryItem.content) {
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: (
          <Text color="red">
            Library item '{itemId}' has no content to open.
          </Text>
        ),
      });
      return;
    }

    // Create temporary file and open it
    const openResult = await createTempFileAndOpen(
      libraryItem.item,
      libraryItem.content,
    );

    if (openResult.success) {
      addOutputEntry({
        id: `library-open-success-${Date.now()}`,
        component: (
          <Text color="green">
            Opened '{libraryItem.item.name}' in default application.
            {openResult.tempPath && <Text dimColor>(Temporary file: {openResult.tempPath})</Text>}
          </Text>
        ),
      });
    } else {
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: <Text color="red">Failed to open file: {openResult.error}</Text>,
      });
    }
  } catch (error) {
    addOutputEntry({
      id: `library-open-error-${Date.now()}`,
      component: (
        <Text color="red">
          Error opening library item: {error instanceof Error ? error.message : String(error)}
        </Text>
      ),
    });
  }
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
};

// Output buffer entry that can hold different component types
interface OutputEntry {
  id: string;
  component: React.ReactElement;
}

function InteractiveCommandInner() {
  const [_inputValue, _setInputValue] = useState("");
  const [view, setView] = useState<
    "help" | "command" | "init" | "config" | "credits"
  >("command");
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
  const [showJobSelection, setShowJobSelection] = useState(false);
  const [showSignalActionSelection, setShowSignalActionSelection] = useState(false);
  const [showSignalTriggerInput, setShowSignalTriggerInput] = useState(false);
  const [currentSelectionWorkspace, setCurrentSelectionWorkspace] = useState<
    string | null
  >(null);
  const [currentSelectedSignal, setCurrentSelectedSignal] = useState<
    string | null
  >(null);
  const [workspaceSelectionContext, setWorkspaceSelectionContext] = useState<
    | "signals-list"
    | "agents-list"
    | "sessions-list"
    | "library"
    | "workspaces"
    | "signals-select"
    | "agents-select"
    | "sessions-select"
    | "jobs-select"
    | null
  >(null);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });
  const { isLeaderKeyActive, setLeaderKeyActive } = useAppContext();

  // LLM conversation state (Phase 1 - Core Integration)
  const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<
    string | null
  >(null);
  const [_isLLMProcessing, setIsLLMProcessing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [sseStream, setSseStream] = useState<AsyncIterable<any> | null>(null);
  const [pendingMessageSpinner, setPendingMessageSpinner] = useState<string | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(-1);
  const pendingMessageSpinnerRef = useRef<string | null>(null);

  // Calculate available height for conversation display
  const availableHeight = Math.max(20, (stdout.rows || 24) - 8); // Reserve space for input

  useEffect(() => {
    const requiredHeight = Math.max(35, availableHeight + 8);
    setMinHeight(requiredHeight);
  }, [availableHeight]);

  // Leader key input handler
  useInput((input, key) => {
    if (key.ctrl && input === "a") {
      setLeaderKeyActive(!isLeaderKeyActive);
      // Reset selection when entering leader key mode
      if (!isLeaderKeyActive) {
        setSelectedOutputIndex(outputBuffer.length - 1);
      } else {
        setSelectedOutputIndex(-1);
      }
    }

    if (isLeaderKeyActive && (key.escape || input === "i")) {
      setLeaderKeyActive(false);
      setSelectedOutputIndex(-1);
    }

    // Arrow key navigation in leader key mode
    if (isLeaderKeyActive && outputBuffer.length > 0) {
      if (key.upArrow) {
        setSelectedOutputIndex((prev) => prev <= 0 ? outputBuffer.length - 1 : prev - 1);
      }
      if (key.downArrow) {
        setSelectedOutputIndex((prev) => prev >= outputBuffer.length - 1 ? 0 : prev + 1);
      }
    }
  });

  // Add intro message on startup and check daemon status
  useEffect(() => {
    const checkDaemonAndInitialize = async () => {
      setOutputBuffer([]);

      try {
        // Try to connect to daemon - this will auto-start it if needed
        const client = getDaemonClient();

        // Show loading state
        setOutputBuffer([
          {
            id: `loading-${Date.now()}`,
            component: (
              <Box paddingLeft={1}>
                <Spinner label="Loading..." />
              </Box>
            ),
          },
        ]);

        // Try to list workspaces - this will trigger auto-start if needed
        const workspaces = await client.listWorkspaces();

        // Initialize ConversationClient for system workspace
        try {
          console.log("[Interactive] Initializing ConversationClient...");
          // Use "system" as the workspace ID for the conversation system workspace
          const conversationClient = new ConversationClient(
            "http://localhost:8080",
            "system",
            "cli-user",
          );

          console.log("[Interactive] Creating conversation session...");
          const session = await conversationClient.createSession();
          console.log("[Interactive] Session created:", session);

          setConversationClient(conversationClient);
          setConversationSessionId(session.sessionId);
          // Store the SSE URL for later use
          conversationClient.sseUrl = session.sseUrl;

          // Start persistent SSE listener
          console.log("[Interactive] Starting persistent SSE listener...");
          const sseIterator = conversationClient.streamEvents(session.sessionId, session.sseUrl);
          setSseStream(sseIterator);

          // Start listening for SSE events in background
          (async () => {
            try {
              for await (const event of sseIterator) {
                console.log("[Interactive] Received SSE event:", event.type, event.data);

                if (event.type === "connection_opened") {
                  // Ignore connection events
                  continue;
                }

                if (event.type === "message_chunk") {
                  const responseMessage = event.data.content;
                  const isPartial = event.data.partial;

                  // Update streaming message
                  const responseTimestamp = new Date()
                    .toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                    .toLowerCase()
                    .replace(/\s/g, "");

                  const streamingMessageId = `llm-response-current`;

                  setOutputBuffer((prev) => {
                    const filtered = prev.filter((entry) => entry.id !== streamingMessageId);
                    return [
                      ...filtered,
                      {
                        id: streamingMessageId,
                        component: (
                          <Box flexDirection="column">
                            <Box flexDirection="row" gap={1}>
                              <Text color="blue" bold>
                                Δ Atlas
                              </Text>
                              <Text color="blue" dimColor bold>
                                [{responseTimestamp}]
                              </Text>
                            </Box>
                            <Box>
                              <Text wrap="wrap" color="white">
                                {responseMessage}
                              </Text>
                            </Box>
                          </Box>
                        ),
                      },
                    ];
                  });
                }

                if (event.type === "message_complete") {
                  console.log("[Interactive] Message completed");
                  console.log(
                    "[Interactive] Current pendingMessageSpinner (state):",
                    pendingMessageSpinner,
                  );
                  console.log(
                    "[Interactive] Current pendingMessageSpinner (ref):",
                    pendingMessageSpinnerRef.current,
                  );

                  // Remove spinner when message is complete - use ref to avoid closure issues
                  const spinnerId = pendingMessageSpinnerRef.current;
                  if (spinnerId) {
                    console.log("[Interactive] Removing spinner on message_complete:", spinnerId);
                    setOutputBuffer((prev) => {
                      const filtered = prev.filter((entry) => entry.id !== spinnerId);
                      console.log(
                        "[Interactive] Filtered out spinner, remaining entries:",
                        filtered.length,
                      );
                      return filtered;
                    });
                    setPendingMessageSpinner(null);
                    pendingMessageSpinnerRef.current = null;
                  } else {
                    console.log("[Interactive] No pendingMessageSpinner to remove");
                  }
                }
              }
            } catch (error) {
              console.error("[Interactive] SSE stream error:", error);
            }
          })();

          console.log("[Interactive] ConversationClient initialized successfully");
        } catch (error) {
          // Log the full error for debugging
          console.error("[Interactive] Failed to initialize conversation client:", error);
          console.error("[Interactive] Full error details:", {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        } finally {
          setIsInitializing(false);
        }

        // Replace loading state with welcome message
        const welcomeTimestamp = new Date()
          .toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })
          .toLowerCase()
          .replace(/\s/g, "");

        setOutputBuffer([
          {
            id: `welcome-${Date.now()}`,
            component: (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color="blue" bold>
                    Δ Atlas
                  </Text>
                  <Text color="blue" dimColor bold>
                    [{welcomeTimestamp}]
                  </Text>
                </Box>
                <Box>
                  <Text wrap="wrap">
                    How can I help you today? Here are some options to get started:
                  </Text>
                </Box>
                <Box marginTop={1}>
                  <UnorderedList>
                    <UnorderedList.Item>
                      <Text>"Tell me about the features in Atlas"</Text>
                    </UnorderedList.Item>
                    <UnorderedList.Item>
                      <Text>"Create a new workspace called..."</Text>
                    </UnorderedList.Item>
                    <UnorderedList.Item>
                      <Text>
                        "Show me any available Workspaces that I can use right now"
                      </Text>
                    </UnorderedList.Item>
                  </UnorderedList>
                </Box>
              </Box>
            ),
          },
        ]);
      } catch (error) {
        // Clear any loading messages and show error
        setOutputBuffer([
          {
            id: `daemon-error-${Date.now()}`,
            component: (
              <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
                <Text color="red">
                  Failed to start Atlas daemon:{" "}
                  {error instanceof Error ? error.message : String(error)}
                </Text>
                <Text dimColor>Try running `atlas daemon start` manually.</Text>
              </Box>
            ),
          },
        ]);
        setIsInitializing(false);
      }
    };

    checkDaemonAndInitialize();
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
      case "jobs-select":
        setCurrentSelectionWorkspace(workspaceId);
        setShowJobSelection(true);
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
    setCurrentSelectedSignal(signalId);
    setShowSignalActionSelection(true);
  };

  // Handle signal action selection (describe/trigger)
  const handleSignalActionSelect = (action: string) => {
    setShowSignalActionSelection(false);
    const workspaceId = currentSelectionWorkspace;
    const signalId = currentSelectedSignal;

    if (!workspaceId || !signalId) {
      addOutputEntry({
        id: `signal-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace or signal selected</Text>,
      });
      setCurrentSelectionWorkspace(null);
      setCurrentSelectedSignal(null);
      return;
    }

    if (action === "describe") {
      addOutputEntry({
        id: `signal-details-${Date.now()}`,
        component: (
          <SignalDetailsWithPath
            workspaceId={workspaceId}
            signalId={signalId}
          />
        ),
      });
      setCurrentSelectionWorkspace(null);
      setCurrentSelectedSignal(null);
    } else if (action === "trigger") {
      setShowSignalTriggerInput(true);
    }
  };

  // Handle signal trigger input
  const handleSignalTriggerSubmit = async (input: string) => {
    setShowSignalTriggerInput(false);
    const workspaceId = currentSelectionWorkspace;
    const signalId = currentSelectedSignal;

    if (!workspaceId || !signalId) {
      addOutputEntry({
        id: `signal-trigger-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace or signal selected</Text>,
      });
      setCurrentSelectionWorkspace(null);
      setCurrentSelectedSignal(null);
      return;
    }

    // Add loading indicator
    addOutputEntry({
      id: `signal-trigger-loading-${Date.now()}`,
      component: (
        <Box flexDirection="column">
          <Text color="cyan">Triggering signal...</Text>
          <Text dimColor>Workspace: {workspaceId}</Text>
          <Text dimColor>Signal: {signalId}</Text>
          <Text dimColor>Payload: {input || "(empty)"}</Text>
        </Box>
      ),
    });

    try {
      const result = await triggerSignalSimple(
        workspaceId,
        signalId,
        input.trim() || undefined,
      );

      // Remove loading entry and add result
      setOutputBuffer((prev) => prev.slice(0, -1));

      if (result.success) {
        addOutputEntry({
          id: `signal-trigger-success-${Date.now()}`,
          component: (
            <Box flexDirection="column">
              <Text color="green">Signal triggered successfully!</Text>
              <Text dimColor>
                Workspace: {result.workspaceName || workspaceId}
              </Text>
              <Text dimColor>Signal: {signalId}</Text>
              {result.sessionId && <Text dimColor>Session ID: {result.sessionId}</Text>}
              {result.status && <Text dimColor>Status: {result.status}</Text>}
              <Text dimColor>Duration: {result.duration.toFixed(2)}ms</Text>
            </Box>
          ),
        });
      } else {
        addOutputEntry({
          id: `signal-trigger-error-${Date.now()}`,
          component: (
            <Box flexDirection="column">
              <Text color="red">Signal trigger failed</Text>
              <Text dimColor>Workspace: {workspaceId}</Text>
              <Text dimColor>Signal: {signalId}</Text>
              <Text color="red">Error: {result.error}</Text>
              <Text dimColor>Duration: {result.duration.toFixed(2)}ms</Text>
            </Box>
          ),
        });
      }
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1));

      addOutputEntry({
        id: `signal-trigger-exception-${Date.now()}`,
        component: (
          <Box flexDirection="column">
            <Text color="red">Unexpected error during signal trigger</Text>
            <Text dimColor>Workspace: {workspaceId}</Text>
            <Text dimColor>Signal: {signalId}</Text>
            <Text color="red">
              Error: {error instanceof Error ? error.message : String(error)}
            </Text>
          </Box>
        ),
      });
    }

    setCurrentSelectionWorkspace(null);
    setCurrentSelectedSignal(null);
  };

  // Handle session selection
  const handleSessionSelect = (sessionId: string) => {
    setShowSessionSelection(false);
    setCurrentSelectionWorkspace(null);
    addOutputEntry({
      id: `session-details-${Date.now()}`,
      component: (
        <Box>
          <SessionDetails sessionId={sessionId} />
        </Box>
      ),
    });
  };

  // Handle agent selection
  const handleAgentSelect = (agentId: string) => {
    setShowAgentSelection(false);

    const workspaceId = currentSelectionWorkspace;
    if (!workspaceId) {
      addOutputEntry({
        id: `agent-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace selected</Text>,
      });
      setCurrentSelectionWorkspace(null);
      return;
    }

    // Add agent details to output buffer
    addOutputEntry({
      id: `agent-details-${Date.now()}`,
      component: <AgentDetails workspaceId={workspaceId} agentId={agentId} />,
    });

    // Clear workspace selection context
    setCurrentSelectionWorkspace(null);
  };

  // Handle job selection
  const handleJobSelect = (jobName: string) => {
    setShowJobSelection(false);

    const workspaceId = currentSelectionWorkspace;
    if (!workspaceId) {
      addOutputEntry({
        id: `job-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace selected</Text>,
      });
      return;
    }

    // Add job details to output buffer using the new JobDetailsWithPath component
    addOutputEntry({
      id: `job-details-${Date.now()}`,
      component: <JobDetailsWithPath workspaceId={workspaceId} jobName={jobName} />,
    });

    // Clear workspace selection context
    setCurrentSelectionWorkspace(null);
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

  // Handle LLM input (Phase 2.1)
  const handleLLMInput = async (input: string) => {
    if (isInitializing) {
      addOutputEntry({
        id: `llm-initializing-${Date.now()}`,
        component: (
          <Text color="yellow">
            Initializing conversation system, please wait...
          </Text>
        ),
      });
      return;
    }

    if (!conversationClient || !conversationSessionId) {
      addOutputEntry({
        id: `llm-error-${Date.now()}`,
        component: (
          <Text color="red">
            Failed to initialize conversation system. Please restart the CLI.
          </Text>
        ),
      });
      return;
    }

    // Add user message using ChatMessage component
    const now = new Date();
    const userTimestamp = now
      .toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
      .toLowerCase()
      .replace(/\s/g, "");
    const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

    // Force immediate render by using setOutputBuffer directly
    setOutputBuffer((prev) => [...prev, {
      id: `user-${Date.now()}`,
      component: (
        <Box flexDirection="column">
          <ChatMessage
            author={currentUser}
            date={userTimestamp}
            message={input}
            authorColor="green"
          />
        </Box>
      ),
    }]);

    // Show processing indicator (using existing Spinner pattern)
    setIsLLMProcessing(true);
    const spinnerId = `llm-processing-${Date.now()}`;
    addOutputEntry({
      id: spinnerId,
      component: <Spinner label="Typing..." />,
    });

    try {
      console.log("[Interactive] Sending message with streamId:", conversationSessionId);

      // Store the spinner ID so the persistent SSE listener can remove it
      console.log("[Interactive] Setting pendingMessageSpinner to:", spinnerId);
      setPendingMessageSpinner(spinnerId);
      pendingMessageSpinnerRef.current = spinnerId;

      // Just send the message - the persistent SSE listener will handle the response
      await conversationClient.sendMessage(conversationSessionId, input);

      // The persistent SSE listener will handle the response and remove the spinner
    } catch (error) {
      setIsLLMProcessing(false);
      setOutputBuffer((prev) => prev.filter((entry) => entry.id !== spinnerId));
      setPendingMessageSpinner(null);
      pendingMessageSpinnerRef.current = null;
      addOutputEntry({
        id: `llm-error-${Date.now()}`,
        component: (
          <Box paddingLeft={1}>
            <Text color="red">
              LLM Error: {error instanceof Error ? error.message : String(error)}
            </Text>
          </Box>
        ),
      });
    }
  };

  // Command execution handler
  const handleCommand = (input: string) => {
    // Don't process empty input
    if (!input || input.trim() === "") {
      return;
    }

    // Parse command
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      // Send non-slash input to LLM
      handleLLMInput(input);
      return;
    }

    // Special handling for certain commands
    if (
      parsed.command === "exit" ||
      parsed.command === "quit" ||
      parsed.command === "q"
    ) {
      Deno.exit(0);
    }

    if (parsed.command === "help") {
      setView("help");
      return;
    }

    if (parsed.command === "init") {
      setView("init");
      return;
    }

    if (parsed.command === "config") {
      setView("config");
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

    if (parsed.command === "agents") {
      setWorkspaceSelectionContext("agents-select");
      setShowAgentWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "job") {
      setWorkspaceSelectionContext("jobs-select");
      setShowAgentWorkspaceSelection(true);
      return;
    }

    if (parsed.command === "library") {
      if (parsed.args[0] === "open" && parsed.args[1]) {
        // Handle /library open <item_id> - fire and forget async operation
        handleLibraryOpenCommand(parsed.args[1], addOutputEntry).catch(
          (error) => {
            addOutputEntry({
              id: `library-open-error-${Date.now()}`,
              component: (
                <Text color="red">
                  Unexpected error: {error instanceof Error ? error.message : String(error)}
                </Text>
              ),
            });
          },
        );
        return;
      }

      // Default library command - show workspace selection
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

    if (parsed.command === "yaml") {
      // Read the example workspace.yml file
      (async () => {
        try {
          const yamlContent = await Deno.readTextFile(
            "/Users/dwoolf/Documents/atlas/examples/atlas-codebase-analyzer/workspace.yml",
          );
          const now = new Date();
          const timestamp = now
            .toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
            .toLowerCase()
            .replace(/\s/g, "");

          addOutputEntry({
            id: `yaml-output-${Date.now()}`,
            component: (
              <Box flexDirection="column">
                <ChatMessage
                  author="Δ Atlas"
                  date={timestamp}
                  message="Here's the example workspace.yml file:"
                  authorColor="blue"
                />
                <YamlDisplay content={yamlContent} />
              </Box>
            ),
          });
        } catch (error) {
          addOutputEntry({
            id: `yaml-error-${Date.now()}`,
            component: (
              <Text color="red">
                Error reading YAML file: {error instanceof Error ? error.message : String(error)}
              </Text>
            ),
          });
        }
      })();
      return;
    }

    if (parsed.command === "diff") {
      // Show example git diff
      const exampleDiff = `function calculateTotal(items) {
-  let total = 0;
-  for (let i = 0; i < items.length; i++) {
-    total += items[i].price;
-  }
+  return items.reduce((total, item) => total + item.price, 0);
 }

 function processOrder(order) {
   const total = calculateTotal(order.items);
+  const tax = total * 0.08;
+  const finalTotal = total + tax;
-  return { total };
+  return { total, tax, finalTotal };
 }`;

      const now = new Date();
      const timestamp = now
        .toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
        .toLowerCase()
        .replace(/\s/g, "");

      addOutputEntry({
        id: `diff-output-${Date.now()}`,
        component: (
          <Box flexDirection="column">
            <ChatMessage
              author="Δ Atlas"
              date={timestamp}
              message="Here's an example git diff:"
              authorColor="blue"
            />
            <GitDiff
              diffContent={exampleDiff}
              startingLine={1}
              endingLine={15}
            />
          </Box>
        ),
      });
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
      // Force immediate exit to avoid waiting for API timeouts
      Deno.exit(0);
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
        <Static items={[1]}>
          {(item) => (
            <Box key={item} flexDirection="column" flexShrink={0}>
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
          )}
        </Static>
      </Box>

      {view === "command" && (
        <>
          {/* Output buffer display */}
          {outputBuffer.length > 0 && (
            <Box flexDirection="column" gap={1}>
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
            : showJobSelection && currentSelectionWorkspace
            ? (
              <JobSelection
                workspaceId={currentSelectionWorkspace}
                onEscape={() => {
                  setShowJobSelection(false);
                  setCurrentSelectionWorkspace(null);
                }}
                onJobSelect={handleJobSelect}
              />
            )
            : showSignalActionSelection && currentSelectedSignal
            ? (
              <SignalActionSelection
                signalId={currentSelectedSignal}
                onEscape={() => {
                  setShowSignalActionSelection(false);
                  setCurrentSelectedSignal(null);
                  setCurrentSelectionWorkspace(null);
                }}
                onActionSelect={handleSignalActionSelect}
              />
            )
            : showSignalTriggerInput && currentSelectedSignal
            ? (
              <SignalTriggerInput
                signalId={currentSelectedSignal}
                onEscape={() => {
                  setShowSignalTriggerInput(false);
                  setCurrentSelectedSignal(null);
                  setCurrentSelectionWorkspace(null);
                }}
                onSubmit={handleSignalTriggerSubmit}
              />
            )
            : (
              <CommandInput
                onSubmit={handleCommand}
                selectedWorkspace={selectedWorkspace}
                isDisabled={isLeaderKeyActive}
              />
            )}
        </>
      )}

      {view === "help" && <Help onExit={() => setView("command")} />}
      {view === "init" && <InitView onExit={() => setView("command")} />}
      {view === "config" && <ConfigView onExit={() => setView("command")} />}
      {view === "credits" && <CreditsView onExit={() => setView("command")} />}
    </Box>
  );
}

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

export default function InteractiveCommand() {
  return (
    <AppProvider>
      <InteractiveCommandInner />
    </AppProvider>
  );
}
