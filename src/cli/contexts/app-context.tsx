import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Spinner, UnorderedList } from "@inkjs/ui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConversationClient } from "../utils/conversation-client.ts";
import { getDaemonClient } from "../utils/daemon-client.ts";
import { MarkdownDisplay } from "../components/markdown-display.tsx";
import { OutputEntry } from "../modules/conversation/index.ts";

interface AtlasConfig {
  apiKey: string;
  daemonPort: string;
  streamMessages: boolean;
}

interface AppContextType {
  isLeaderKeyActive: boolean;
  setLeaderKeyActive: (active: boolean) => void;
  config: AtlasConfig;
  updateConfig: (newConfig: AtlasConfig) => void;
  mcpClient: Client | null;
  initializeMcpClient: () => Promise<void>;
  outputBuffer: OutputEntry[];
  setOutputBuffer: React.Dispatch<React.SetStateAction<OutputEntry[]>>;
  conversationClient: ConversationClient | null;
  setConversationClient: React.Dispatch<
    React.SetStateAction<ConversationClient | null>
  >;
  conversationSessionId: string | null;
  setConversationSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  sseAbortControllerRef: React.RefObject<AbortController | null>;
  sseStream: AsyncIterable<unknown> | null;
  setSseStream: React.Dispatch<
    React.SetStateAction<AsyncIterable<unknown> | null>
  >;
  isTyping: boolean;
  setIsTyping: React.Dispatch<React.SetStateAction<boolean>>;
  isInitializing: boolean;
  initializeSystem: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [isLeaderKeyActive, setIsLeaderKeyActive] = useState(false);
  const [config, setConfig] = useState<AtlasConfig>({
    apiKey: "",
    daemonPort: "8080",
    streamMessages: true,
  });
  const [mcpClient, setMcpClient] = useState<Client | null>(null);

  // Conversation state from conversation component
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<
    string | null
  >(null);
  const sseAbortControllerRef = useRef<AbortController | null>(null);
  const [sseStream, setSseStream] = useState<AsyncIterable<unknown> | null>(
    null,
  );
  const [isTyping, setIsTyping] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const sseListenerStarted = useRef(false);

  // Store transport reference for cleanup
  const mcpTransportRef = useRef<StreamableHTTPClientTransport | null>(null);

  // Store config in a ref so SSE handler always has latest value
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    return () => {
      // Close the transport connection
      if (mcpTransportRef.current) {
        mcpTransportRef.current.close();
        mcpTransportRef.current = null;
      }

      setMcpClient(null);

      // Clean up SSE connection
      if (sseAbortControllerRef.current) {
        sseAbortControllerRef.current.abort();
        sseAbortControllerRef.current = null;
      }
    };
  }, []);

  const setLeaderKeyActive = (active: boolean) => {
    setIsLeaderKeyActive(active);
  };

  const updateConfig = (newConfig: AtlasConfig) => {
    setConfig(newConfig);
  };

  const initializeMcpClient = async () => {
    try {
      const client = new Client({
        name: "atlas-mcp-client",
        version: "1.0.0",
      });

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${config.daemonPort}/mcp`),
      );

      mcpTransportRef.current = transport;
      await client.connect(transport);
      setMcpClient(client);
    } catch (error) {
      // Silently fail - MCP features won't be available
    }
  };

  const initializeSystem = async () => {
    // Prevent multiple initializations
    if (hasInitialized || isInitializing) {
      return;
    }

    setOutputBuffer([]);
    setIsInitializing(true);
    setHasInitialized(true);

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
        const newConversationClient = new ConversationClient(
          "http://localhost:8080",
          "system",
          "cli-user",
        );

        const session = await newConversationClient.createSession();

        setConversationClient(newConversationClient);
        setConversationSessionId(session.sessionId);
        // Store the SSE URL for later use
        newConversationClient.sseUrl = session.sseUrl;

        // Start persistent SSE listener with AbortController
        const abortController = new AbortController();
        sseAbortControllerRef.current = abortController;

        const sseIterator = newConversationClient.streamEvents(
          session.sessionId,
          session.sseUrl,
          abortController.signal,
        );
        setSseStream(sseIterator);

        // Start listening for SSE events in background (only once)
        if (!sseListenerStarted.current) {
          sseListenerStarted.current = true;
          (async () => {
            try {
              for await (const event of sseIterator) {
                // Check if we should stop
                if (abortController.signal.aborted) {
                  break;
                }

                // @ts-expect-error event is currently untyped.
                if (event.type === "message_chunk") {
                  // @ts-expect-error event is currently untyped.
                  const responseMessage = event.data.content;
                  // @ts-expect-error event is currently untyped.
                  const isPartial = event.data.partial;

                  // If streaming is enabled, show all chunks
                  // If streaming is disabled, only show when partial is false (complete message)
                  if (configRef.current.streamMessages || !isPartial) {
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
                // @ts-expect-error event is currently untyped.
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
        }
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

      // Initialize MCP client now that daemon is running
      await initializeMcpClient();
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

  return (
    <AppContext.Provider
      value={{
        isLeaderKeyActive,
        setLeaderKeyActive,
        config,
        updateConfig,
        mcpClient,
        initializeMcpClient,
        outputBuffer,
        setOutputBuffer,
        conversationClient,
        setConversationClient,
        conversationSessionId,
        setConversationSessionId,
        sseAbortControllerRef,
        sseStream,
        setSseStream,
        isTyping,
        setIsTyping,
        isInitializing,
        initializeSystem,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return context;
};
