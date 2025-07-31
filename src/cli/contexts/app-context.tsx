import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConversationClient } from "../utils/conversation-client.ts";
import { getDaemonClient } from "../utils/daemon-client.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";
import { OutputEntry } from "../modules/conversation/index.ts";
import { ChatMessage } from "../components/chat-message.tsx";

interface ConversationDisplayPrefs {
  showReasoningSteps: boolean;
  showToolCalls: boolean;
  showToolResults: boolean;
}

interface AtlasConfig {
  apiKey: string;
  daemonPort: string;
  streamMessages: boolean;
  conversationDisplay: ConversationDisplayPrefs;
}

interface TypingState {
  isTyping: boolean;
  elapsedSeconds: number;
  message?: string;
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
  typingState: TypingState;
  setTypingState: React.Dispatch<React.SetStateAction<TypingState>>;
  isInitializing: boolean;
  exitApp: () => Promise<void>;
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
    conversationDisplay: {
      showReasoningSteps: true,
      showToolCalls: true,
      showToolResults: true,
    },
  });
  const [mcpClient, setMcpClient] = useState<Client | null>(null);

  // Conversation state from conversation component
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<
    string | null
  >(null);
  const sseAbortControllerRef = useRef<AbortController | null>(null);
  const [typingState, setTypingState] = useState<TypingState>({
    isTyping: false,
    elapsedSeconds: 0,
  });
  const [isInitializing, setIsInitializing] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const timerIntervalRef = useRef<number | null>(null);

  // Store transport reference for cleanup
  const mcpTransportRef = useRef<StreamableHTTPClientTransport | null>(null);

  // Store config in a ref so SSE handler always has latest value
  const configRef = useRef(config);

  async function cleanup() {
    if (mcpTransportRef.current) {
      await mcpTransportRef.current.close();
    }

    // Clean up SSE connection before exit
    if (sseAbortControllerRef.current) {
      sseAbortControllerRef.current.abort();
      sseAbortControllerRef.current = null;
    }
  }

  async function exitApp() {
    await cleanup();

    // Show cursor before exiting
    console.log("\x1b[?25h");

    Deno.exit(0);
  }

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Timer effect for non-streaming mode
  useEffect(() => {
    if (typingState.isTyping && !config.streamMessages) {
      const startTime = Date.now();
      setTypingState((prev) => ({ ...prev, elapsedSeconds: 0 }));

      const interval = setInterval(() => {
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        setTypingState((prev) => ({ ...prev, elapsedSeconds: elapsed }));
      }, 1000);

      timerIntervalRef.current = interval;

      return () => {
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
      };
    } else if (!typingState.isTyping) {
      // Clean up timer when typing stops
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setTypingState((prev) => ({ ...prev, elapsedSeconds: 0 }));
    }
  }, [typingState.isTyping, config.streamMessages]);

  useEffect(() => {
    initializeSystem();
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

      const daemonUrl = getAtlasDaemonUrl();
      const transport = new StreamableHTTPClientTransport(
        new URL(`${daemonUrl}/mcp`),
      );

      mcpTransportRef.current = transport;
      await client.connect(transport);
      setMcpClient(client);
    } catch {
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
        // Use "atlas-conversation" as the workspace ID for the conversation system workspace
        const newConversationClient = new ConversationClient(
          getAtlasDaemonUrl(),
          "atlas-conversation",
          "cli-user",
        );

        const session = await newConversationClient.createSession();

        setConversationClient(newConversationClient);
        setConversationSessionId(session.sessionId);
        // Store the SSE URL for later use
        newConversationClient.sseUrl = session.sseUrl;

        // Create AbortController for SSE
        const abortController = new AbortController();
        sseAbortControllerRef.current = abortController;
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
            <ChatMessage
              author="Atlas"
              date={welcomeTimestamp}
              message={`How can I help you today? Here are some options to get started:
- "Tell me about the features in Atlas"
- "Create a new workspace called..."
- "Show me any available Workspaces that I can use right now"`}
              authorColor="blue"
            />
          ),
        },
      ]);

      // Initialize MCP client now that daemon is running
      await initializeMcpClient();
    } catch (error) {
      // Clear any loading messages and show error
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if the error message already has helpful instructions
      const hasInstructions = errorMessage.includes("atlas service start");

      setOutputBuffer([
        {
          id: `daemon-error-${Date.now()}`,
          component: (
            <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
              <Text color="red">
                {errorMessage}
              </Text>
              {!hasInstructions && (
                <Text dimColor>Try running `atlas service start` manually.</Text>
              )}
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
        typingState,
        setTypingState,
        isInitializing,
        exitApp,
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
