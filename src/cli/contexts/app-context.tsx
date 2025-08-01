import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useStdout } from "ink";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConversationClient } from "../utils/conversation-client.ts";
import { getDaemonClient } from "../utils/daemon-client.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";
import { DiagnosticsCollector } from "../../utils/diagnostics-collector.ts";
import { getAtlasClient } from "@atlas/client";

import ansiEscapes from "ansi-escapes";

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
  isCollapsed: boolean;
  setIsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  config: AtlasConfig;
  updateConfig: (newConfig: AtlasConfig) => void;
  mcpClient: Client | null;
  initializeMcpClient: () => Promise<void>;
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
  sendDiagnostics: () => Promise<void>;
  diagnosticsStatus: "idle" | "collecting" | "uploading" | "done" | string;
  daemonStatus: "healthy" | "unhealthy" | "error" | "idle";
  setDaemonStatus: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
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
  const [daemonStatus, setDaemonStatusState] = useState<
    "healthy" | "unhealthy" | "error" | "idle"
  >("idle");
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<
    "idle" | "collecting" | "uploading" | "done" | string
  >("idle");

  // const timerIntervalRef = useRef<number | null>(null);

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
  // useEffect(() => {
  //   if (typingState.isTyping && !config.streamMessages) {
  //     const startTime = Date.now();
  //     setTypingState((prev) => ({ ...prev, elapsedSeconds: 0 }));

  //     const interval = setInterval(() => {
  //       const now = Date.now();
  //       const elapsed = Math.floor((now - startTime) / 1000);
  //       setTypingState((prev) => ({ ...prev, elapsedSeconds: elapsed }));
  //     }, 1000);

  //     timerIntervalRef.current = interval;

  //     return () => {
  //       if (timerIntervalRef.current) {
  //         clearInterval(timerIntervalRef.current);
  //         timerIntervalRef.current = null;
  //       }
  //     };
  //   } else if (!typingState.isTyping) {
  //     // Clean up timer when typing stops
  //     if (timerIntervalRef.current) {
  //       clearInterval(timerIntervalRef.current);
  //       timerIntervalRef.current = null;
  //     }
  //     setTypingState((prev) => ({ ...prev, elapsedSeconds: 0 }));
  //   }
  // }, [typingState.isTyping, config.streamMessages]);

  useEffect(() => {
    initializeSystem();
  }, []);

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

    setIsInitializing(true);
    setHasInitialized(true);

    try {
      // Try to connect to daemon - this will auto-start it if needed
      const client = getDaemonClient();

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

      // Initialize MCP client now that daemon is running
      await initializeMcpClient();
    } catch (error) {
      // Clear any loading messages and show error
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`Failed to start Atlas daemon: ${errorMessage}`);

      setIsInitializing(false);
    }
  };

  const setDaemonStatus = async () => {
    try {
      // Use getAtlasClient for consistent behavior, but with a short timeout
      const client = getAtlasClient({ timeout: 1000 }); // 1 second timeout for status check
      const isHealthy = await client.isHealthy();

      if (isHealthy) {
        setDaemonStatusState("healthy");
      } else {
        setDaemonStatusState("unhealthy");
      }
    } catch (_error) {
      setDaemonStatusState("error");
    }

    setTimeout(() => {
      setDaemonStatusState("idle");
    }, 5000);
  };

  const sendDiagnostics = async () => {
    let gzipPath: string | undefined;

    try {
      // Collect diagnostics
      const collector = new DiagnosticsCollector();
      gzipPath = await collector.collectAndArchive();

      // Check size
      const fileInfo = await Deno.stat(gzipPath);
      if (fileInfo.size > 100 * 1024 * 1024) {
        // 100MB
        throw new Error(
          "Diagnostic archive too large (>100MB). Please contact support.",
        );
      }

      setDiagnosticsStatus("uploading");

      // Upload via client
      const client = getAtlasClient();
      await client.sendDiagnostics(gzipPath);

      // Clean up temp file
      await Deno.remove(gzipPath).catch(() => {}); // Ignore cleanup errors

      setDiagnosticsStatus("done");
      // setMessage("Diagnostics sent successfully!");

      // Complete after showing success for a moment
      setTimeout(() => {
        setDiagnosticsStatus("done");
      }, 2000);
    } catch (err) {
      setDiagnosticsStatus(err instanceof Error ? err.message : String(err));

      // Try to clean up on error too
      if (gzipPath) {
        await Deno.remove(gzipPath).catch(() => {});
      }
    }

    // Complete after showing error for a moment
    setTimeout(() => {
      setDiagnosticsStatus("idle");
    }, 5000);
  };

  return (
    <AppContext.Provider
      value={{
        isCollapsed,
        setIsCollapsed,
        config,
        updateConfig,
        mcpClient,
        initializeMcpClient,
        conversationClient,
        setConversationClient,
        conversationSessionId,
        setConversationSessionId,
        sseAbortControllerRef,
        typingState,
        setTypingState,
        isInitializing,
        exitApp,
        sendDiagnostics,
        diagnosticsStatus,
        daemonStatus,
        setDaemonStatus,
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
