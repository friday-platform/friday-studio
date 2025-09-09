import type { SessionUIMessage, SessionUIMessageChunk, SessionUIMessagePart } from "@atlas/core";
import { readUIMessageStream } from "ai";
import { getContext, setContext } from "svelte";
import { getAtlasDaemonUrl } from "../../utils/daemon.ts";
import { ConversationClient, type ConversationSession } from "./conversation.ts";
import type { DaemonClient } from "./daemon.ts";

const KEY = Symbol();

class ClientContext {
  client: DaemonClient;

  private isSetupComplete = false;
  private healthCheckInterval: number | null = null;
  private countdownInterval: number | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 5000;

  public conversationClient: ConversationClient | null = null;
  sseStream: ReadableStream<SessionUIMessageChunk> | null = null;
  // Svelte reactive values
  typingState = $state({ isTyping: false, elapsedSeconds: 0 });
  messages = $state<SessionUIMessagePart[]>([]);
  messageHistory = $state<SessionUIMessagePart[]>([]);
  user = $state<string>("NA");
  atlasSessionId = $state<string | null>(null);
  daemonStatus = $state<"connected" | "error" | "idle">("idle");
  pastConversations = $state<string[]>([]);
  reconnectCountdown = $state<number>(0);
  conversationSessionId = $state<string | null>(null);

  sseAbortController: AbortController | null = null;

  constructor(client: DaemonClient) {
    this.client = client;
  }

  getAtlasDaemonUrl() {
    return getAtlasDaemonUrl();
  }

  async getUser() {
    if (!this.conversationClient) {
      return;
    }

    const data = await this.conversationClient.getUser();

    if (data.success) {
      this.user = data.currentUser;
    }
  }

  setup() {
    // If setup is already complete and daemon is connected, skip
    if (this.isSetupComplete && this.daemonStatus === "connected") {
      return;
    }

    // Clean up any existing connections but preserve session data
    this.cleanup(true, true);
  }

  connect() {
    try {
      // Use "atlas-conversation" as the workspace ID for the conversation system workspace
      this.conversationClient = new ConversationClient(
        getAtlasDaemonUrl(),
        "atlas-conversation",
        "cli-user",
      );
    } catch (error) {
      // Clear any loading messages and show error
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`Failed to start Atlas daemon: ${errorMessage}`);
    }
  }

  async createSession() {
    try {
      if (!this.conversationClient) {
        this.connect();
      }

      let session: ConversationSession | null | undefined;

      // Try to reconnect to existing session if we have one
      if (this.conversationSessionId) {
        const existingSession = await this.conversationClient?.getSession(
          this.conversationSessionId,
        );

        if (existingSession) {
          console.log(`Reconnecting to existing session: ${this.conversationSessionId}`);
          session = existingSession;
        } else {
          console.log("Previous session no longer exists, creating new session");
          session = await this.conversationClient?.createSession();

          // Clear messages since we're starting fresh
          this.messages = [];
        }
      } else {
        session = await this.conversationClient?.createSession();
      }

      if (!session) return;

      // duplicate if there is an existing session, but cleaner overall to ensure the session exists first
      this.conversationSessionId = session.sessionId;

      const stream = this.conversationClient?.createMessageStream(session.sseUrl);

      // Create AbortController for SSE
      this.sseAbortController = new AbortController();

      if (!stream) return;

      this.sseStream = stream;

      this.getUser();

      // Mark setup as complete before starting the stream
      this.isSetupComplete = true;
      this.daemonStatus = "connected";

      // Clear countdown when connected
      this.reconnectCountdown = 0;
      this.stopCountdownInterval();

      // Start health check interval
      this.startHealthCheckInterval();

      for await (const uiMessage of readUIMessageStream<SessionUIMessage>({ stream })) {
        // Check if we should stop processing (e.g., if cleanup was called)
        if (!this.sseAbortController || this.sseAbortController.signal.aborted) {
          break;
        }

        uiMessage.parts.forEach((part) => {
          if (part.type === "data-session-start") {
            // Capture the Atlas session ID
            this.atlasSessionId = part.data.sessionId;
            if (!this.typingState.isTyping) {
              this.typingState.isTyping = true;
            }
          } else if (part.type === "data-session-finish") {
            this.typingState.isTyping = false;
            this.atlasSessionId = null;
          } else if (part.type === "data-session-cancel") {
            this.typingState.isTyping = false;
            this.atlasSessionId = null;
          }
        });

        this.messages = uiMessage.parts;
      }

      // If we reached here and the abort signal wasn't triggered,
      // it means the SSE stream ended unexpectedly (daemon likely stopped)
      if (this.sseAbortController && !this.sseAbortController.signal.aborted) {
        console.error("SSE stream ended unexpectedly - daemon may be down");
        this.daemonStatus = "error";
        this.isSetupComplete = false;
        // Keep health checks running and preserve session to reconnect
        this.cleanup(false, true);
        // Ensure health checks and countdown are running
        if (this.healthCheckInterval === null) {
          this.startHealthCheckInterval();
        }
      }
    } catch (error) {
      // Clear any loading messages and show error
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`Failed to setup conversation client: ${errorMessage}`);

      // Mark setup as incomplete and set error status
      this.isSetupComplete = false;
      this.daemonStatus = "error";

      // Clean up on error but keep health checks running and preserve session
      this.cleanup(false, true);
      // Ensure health checks are running to detect when daemon comes back
      this.startHealthCheckInterval();
    }
  }

  async checkHealth() {
    // If manually triggered and in error state, show reconnecting status
    if (this.daemonStatus === "error" && this.reconnectCountdown > 0) {
      this.reconnectCountdown = 0;
    }

    try {
      // First check if daemon is healthy using the client directly
      const isDaemonHealthy = await this.client.isHealthy();

      if (isDaemonHealthy) {
        const previousStatus = this.daemonStatus;
        this.daemonStatus = "connected";

        // If we're transitioning from error to connected, setup the conversation
        if (previousStatus === "error" || !this.isSetupComplete) {
          this.setup();
        }
      } else {
        this.daemonStatus = "error";
        this.isSetupComplete = false;
        // Clean up resources but keep health checks running and preserve session
        this.cleanup(false, true);
        // Ensure health checks continue to detect when daemon comes back
        if (this.healthCheckInterval === null) {
          this.startHealthCheckInterval();
        }
      }
    } catch {
      this.daemonStatus = "error";
      this.isSetupComplete = false;
      // Clean up resources but keep health checks running and preserve session
      this.cleanup(false, true);
      // Ensure health checks continue to detect when daemon comes back
      if (this.healthCheckInterval === null) {
        this.startHealthCheckInterval();
      }
    }
  }

  private cleanup(stopHealthChecks = true, preserveSession = false) {
    // Abort any existing SSE connection
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }

    // Clear stream reference
    this.sseStream = null;

    // Clear session references only if not preserving
    if (!preserveSession) {
      this.conversationSessionId = null;
      this.atlasSessionId = null;
      // Only clear messages if not preserving session
      this.messages = [];
    }

    // Reset typing state
    this.typingState.isTyping = false;

    // Stop health check interval only if requested
    if (stopHealthChecks) {
      this.stopHealthCheckInterval();
      this.stopCountdownInterval();
      this.reconnectCountdown = 0;
    }
  }

  startHealthCheckInterval() {
    // Stop any existing intervals
    this.stopHealthCheckInterval();
    this.stopCountdownInterval();

    // Reset countdown
    this.reconnectCountdown = Math.floor(this.HEALTH_CHECK_INTERVAL_MS / 1000);

    // Start countdown timer (updates every second)
    this.countdownInterval = setInterval(() => {
      if (this.reconnectCountdown > 0) {
        this.reconnectCountdown--;
      }
    }, 1000);

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
      // Reset countdown after each check
      if (this.daemonStatus === "error") {
        this.reconnectCountdown = Math.floor(this.HEALTH_CHECK_INTERVAL_MS / 1000);
      }
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheckInterval() {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private stopCountdownInterval() {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  async getConversation(id: string) {
    if (!this.conversationClient) {
      this.connect();
    }

    const messages = await this.conversationClient?.getConversation(id);

    if (messages) {
      this.messageHistory = messages.flatMap((message) => message.parts);
    }
  }

  async listConversations() {
    if (!this.conversationClient) {
      this.connect();
    }

    const conversations = await this.conversationClient?.listConversations();

    if (conversations) {
      this.pastConversations = conversations;
    }
  }

  // Method to stop all monitoring when component is destroyed
  destroy() {
    this.cleanup();
  }
}

export function setClientContext(client: DaemonClient) {
  const ctx = new ClientContext(client);
  return setContext(KEY, ctx);
}

export function getClientContext() {
  return getContext<ReturnType<typeof setClientContext>>(KEY);
}
