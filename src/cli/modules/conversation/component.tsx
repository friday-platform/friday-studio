import { useEffect, useRef, useState } from "react";
import { Box, Newline, Static, Text, useApp, useInput, useStdout } from "ink";
import { Spinner, UnorderedList } from "@inkjs/ui";
import { AgentDetails } from "../../components/agent-details.tsx";
import { AgentSelection } from "../../components/agent-selection.tsx";
import { ChatMessage } from "../../components/chat-message.tsx";
import { CommandInput } from "../../components/command-input.tsx";
import { JobSelection } from "../../components/job-selection.tsx";
import { MarkdownDisplay } from "../../components/markdown-display.tsx";
import { SessionDetails } from "../../components/session-details.tsx";
import { SessionSelection } from "../../components/session-selection.tsx";
import { SignalActionSelection } from "../../components/signal-action-selection.tsx";
import { SignalSelection } from "../../components/signal-selection.tsx";
import { SignalTriggerInput } from "../../components/signal-trigger-input.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { AgentListComponent } from "../agents/agent-list-component.tsx";
import { processAgentsFromConfig } from "../agents/processor.ts";
import { fetchLibraryItems } from "../library/fetcher.ts";
import { LibraryListComponent } from "../library/library-list-component.tsx";
import { fetchSessions } from "../sessions/fetcher.ts";
import { SessionListComponent } from "../sessions/session-list-component.tsx";
import { SignalListComponent } from "../signals/SignalListComponent.tsx";
import { triggerSignalSimple } from "../signals/trigger.ts";
import { loadWorkspaceConfigNoCwd } from "../workspaces/resolver.ts";
import { ConversationClient } from "../../utils/conversation-client.ts";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { ConfigView } from "../../views/ConfigView.tsx";
import CreditsView from "../../views/CreditsView.tsx";
import Help from "../../views/help.tsx";
import { InitView } from "../../views/InitView.tsx";
import {
  COMMAND_REGISTRY,
  handleLibraryOpenCommand,
  OutputEntry,
  parseSlashCommand,
} from "./index.ts";
import { JobDetailsWithPath } from "./job-details-with-path.tsx";
import { SignalDetailsWithPath } from "./signal-details-with-path.tsx";
import { WorkspaceSelection } from "./workspace-selection.tsx";

// Helper function to get workspace by ID using daemon API
const getWorkspaceById = async (workspaceId: string) => {
  try {
    const client = getDaemonClient();
    return await client.getWorkspace(workspaceId);
  } catch {
    return null;
  }
};

export function Component() {
  const { config } = useAppContext();
  const [view, setView] = useState<
    "help" | "command" | "init" | "config" | "credits"
  >("command");
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const [showWorkspaceSelection, setShowWorkspaceSelection] = useState(false);
  const [
    showWorkspacesWorkspaceSelection,
    setShowWorkspacesWorkspaceSelection,
  ] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );
  const [showAgentWorkspaceSelection, setShowAgentWorkspaceSelection] = useState(false);
  const [showLibraryWorkspaceSelection, setShowLibraryWorkspaceSelection] = useState(false);
  const [showSessionsWorkspaceSelection, setShowSessionsWorkspaceSelection] = useState(false);
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
  const { stdout: _stdout } = useStdout();
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Handle Ctrl+C for graceful shutdown
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      if (sseAbortControllerRef.current) {
        sseAbortControllerRef.current.abort();
        sseAbortControllerRef.current = null;
      }
      exit();
    }
  });

  // LLM conversation state (Phase 1 - Core Integration)
  const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<
    string | null
  >(null);

  const [isInitializing, setIsInitializing] = useState(true);
  const [_sseStream, setSseStream] = useState<AsyncIterable<unknown> | null>(
    null,
  );
  const sseAbortControllerRef = useRef<AbortController | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [_typingStartTime, setTypingStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerIntervalRef = useRef<number | null>(null);

  // Timer effect for non-streaming mode
  useEffect(() => {
    if (isTyping && !config.streamMessages) {
      const startTime = Date.now();
      setTypingStartTime(startTime);
      setElapsedSeconds(0);

      const interval = setInterval(() => {
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        setElapsedSeconds(elapsed);
      }, 1000);

      timerIntervalRef.current = interval;

      return () => {
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
      };
    } else if (!isTyping) {
      // Clean up timer when typing stops
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setTypingStartTime(null);
      setElapsedSeconds(0);
    }
  }, [isTyping, config.streamMessages]);

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
        await client.listWorkspaces();

        // Initialize ConversationClient for system workspace
        try {
          // Use "system" as the workspace ID for the conversation system workspace
          const conversationClient = new ConversationClient(
            "http://localhost:8080",
            "system",
            "cli-user",
          );

          const session = await conversationClient.createSession();

          setConversationClient(conversationClient);
          setConversationSessionId(session.sessionId);
          // Store the SSE URL for later use
          conversationClient.sseUrl = session.sseUrl;

          // Start persistent SSE listener with AbortController
          const abortController = new AbortController();
          sseAbortControllerRef.current = abortController;

          const sseIterator = conversationClient.streamEvents(
            session.sessionId,
            session.sseUrl,
            abortController.signal,
          );
          setSseStream(sseIterator);

          // Start listening for SSE events in background
          (async () => {
            try {
              for await (const event of sseIterator) {
                // Check if we should stop
                if (abortController.signal.aborted) {
                  break;
                }

                if (event.type === "message_chunk") {
                  const responseMessage = event.data.content;
                  const isPartial = event.data.partial;

                  // If streaming is enabled, show all chunks
                  // If streaming is disabled, only show when partial is false (complete message)
                  if (config.streamMessages || !isPartial) {
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
                      const filtered = prev.filter(
                        (entry) => entry.id !== streamingMessageId,
                      );
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
                                <MarkdownDisplay content={responseMessage} />
                              </Box>
                            </Box>
                          ),
                        },
                      ];
                    });
                  }
                }

                if (event.type === "message_complete") {
                  // Update streaming message ID to make it permanent
                  const streamingMessageId = `llm-response-current`;
                  const permanentMessageId = `message-received-${Date.now()}`;

                  setOutputBuffer((prev) => {
                    return prev.map((entry) => {
                      if (entry.id === streamingMessageId) {
                        return {
                          ...entry,
                          id: permanentMessageId,
                        };
                      }
                      return entry;
                    });
                  });

                  // Stop typing indicator
                  setIsTyping(false);
                }
              }
            } catch {
              // Ignore errors from aborted streams
              if (!abortController.signal.aborted) {
                // Add error handling here if needed
              }
            }
          })();
        } catch {
          // Add error handling here if needed
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

    // Cleanup function
    return () => {
      if (sseAbortControllerRef.current) {
        sseAbortControllerRef.current.abort();
        sseAbortControllerRef.current = null;
      }
    };
  }, [config]);

  // Add entry to output buffer
  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  // Handle workspace selection for workspaces command
  const handleWorkspaceSelectForWorkspaces = async (workspaceId: string) => {
    setShowWorkspacesWorkspaceSelection(false);

    // Handle special "none" case to exit workspace
    if (workspaceId === "none") {
      setSelectedWorkspace(null);

      // Add workspace exit message to output buffer
      const terminalWidth = dimensions.paddedWidth;
      const messageText = ` Exited workspace `;
      const totalDashes = Math.max(0, terminalWidth - messageText.length);
      const leftDashes = Math.floor(totalDashes / 2);
      const rightDashes = totalDashes - leftDashes;
      const formattedMessage = "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

      addOutputEntry({
        id: `workspace-exited-${Date.now()}`,
        component: (
          <Box width={terminalWidth}>
            <Text dimColor>{formattedMessage}</Text>
          </Box>
        ),
      });
      return;
    }

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (workspace) {
        setSelectedWorkspace(workspace.name);

        // Add workspace selection message to output buffer
        const workspaceName = workspace.name;
        const terminalWidth = dimensions.paddedWidth;
        const messageText = ` Entered: ${workspaceName} `;
        const totalDashes = Math.max(0, terminalWidth - messageText.length);
        const leftDashes = Math.floor(totalDashes / 2);
        const rightDashes = totalDashes - leftDashes;
        const formattedMessage = "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

        addOutputEntry({
          id: `workspace-selected-${Date.now()}`,
          component: (
            <Box width={terminalWidth}>
              <Text dimColor>{formattedMessage}</Text>
            </Box>
          ),
        });
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
    }
  };

  // Handle workspace selection for agents
  const handleWorkspaceSelectForAgents = async (workspaceId: string) => {
    setShowAgentWorkspaceSelection(false);

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
    }
  };

  // Handle workspace selection for library
  const handleWorkspaceSelectForLibrary = async (workspaceId: string) => {
    setShowLibraryWorkspaceSelection(false);

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
    }
  };

  // Handle workspace selection for sessions
  const handleWorkspaceSelectForSessions = async (workspaceId: string) => {
    setShowSessionsWorkspaceSelection(false);

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
    setOutputBuffer((prev) => [
      ...prev,
      {
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
      },
    ]);

    // Show typing indicator
    setIsTyping(true);

    try {
      // Just send the message - the persistent SSE listener will handle the response
      await conversationClient.sendMessage(conversationSessionId, input);

      // The persistent SSE listener will handle the response
    } catch (error) {
      setIsTyping(false);
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
      // Clean up SSE connection before exit
      if (sseAbortControllerRef.current) {
        sseAbortControllerRef.current.abort();
        sseAbortControllerRef.current = null;
      }
      // Use Ink's exit function for graceful shutdown
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

          {/* Typing indicator */}
          {isTyping && (
            <Box marginTop={1}>
              {config.streamMessages
                ? <Spinner label="Typing..." />
                : <Spinner label={`Typing... (${elapsedSeconds}s)`} />}
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
