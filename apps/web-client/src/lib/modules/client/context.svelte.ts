import { client, parseResult } from "@atlas/client/v2";
import type { SessionUIMessage, SessionUIMessageChunk, SessionUIMessagePart } from "@atlas/core";
import { formatMessage } from "../messages/format";
import type { OutputEntry } from "../messages/types";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { readUIMessageStream } from "ai";
import { getContext, setContext } from "svelte";
import { getAtlasDaemonUrl } from "../../utils/daemon.ts";
import { ConversationClient, type ConversationSession } from "./conversation.ts";
import type { DaemonClient } from "./daemon.ts";

const KEY = Symbol();

// ABSOLUTE notification blocker - prevents ANY duplicate notifications
let NOTIFICATION_BLOCKED_UNTIL = 0;

class ClientContext {
  client: DaemonClient;

  private isSetupComplete = false;
  private healthCheckInterval: number | null = null;
  private countdownInterval: number | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 5000;
  private windowFocused = true;
  private notificationPermissionGranted = false;
  private waitingForAtlasResponse = false;
  private notifiedSessions = new Set<string>();
  private currentSessionForNotification: string | null = null;
  private currentConversationId: string | null = null;
  private seenPartKeys = new Set<string>();

  public conversationClient: ConversationClient | null = null;
  sseStream: ReadableStream<SessionUIMessageChunk> | null = null;
  // Svelte reactive values
  typingState = $state({ isTyping: false, elapsedSeconds: 0 });
  messages = $state<SessionUIMessagePart[]>([]);
  messageHistory = $state<SessionUIMessagePart[]>([]);
  formattedMessages = $state<OutputEntry[]>([]);
  user = $state<string>("NA");
  atlasSessionId = $state<string | null>(null);
  daemonStatus = $state<"connected" | "error" | "idle">("idle");
  reconnectCountdown = $state<number>(0);
  conversationSessionId = $state<string | null>(null);

  sseAbortController: AbortController | null = null;

  constructor(client: DaemonClient) {
    this.client = client;
    // Only initialize Tauri features in the browser, not during SSR
    if (typeof window !== "undefined") {
      this.initializeNotifications();
      this.setupWindowFocusTracking();
    }
  }

  private async initializeNotifications() {
    try {
      // Check if permission to send notifications has already been granted
      let permissionGranted = await isPermissionGranted();

      // If not, request it
      if (!permissionGranted) {
        const permission = await requestPermission();
        permissionGranted = permission === "granted";
      }

      this.notificationPermissionGranted = permissionGranted;
    } catch (error) {
      console.error("Failed to initialize notifications:", error);
    }
  }

  private setupWindowFocusTracking() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.windowFocused = document.visibilityState === "visible";

        // When window gains focus, clear notification state but keep message tracking
        if (this.windowFocused) {
          this.waitingForAtlasResponse = false;
          // Don't clear notifiedMessages - we need to remember what we've already notified about
          // Also reset the blocker when window gains focus
          NOTIFICATION_BLOCKED_UNTIL = 0;
        }
      });
      this.windowFocused = document.visibilityState === "visible";
    }
  }

  private async sendResponseNotification() {
    const now = Date.now();

    // ABSOLUTE BLOCK - no notifications allowed until cooldown expires
    if (now < NOTIFICATION_BLOCKED_UNTIL) {
      return;
    }

    // Block all future notifications for 30 seconds
    NOTIFICATION_BLOCKED_UNTIL = now + 30000;

    try {
      await sendNotification({
        title: "Atlas",
        body: "Atlas is waiting for your input",
        sound: "default",
      });
    } catch (error) {
      console.error("Failed to send notification:", error);
    }
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
      this.refreshFormattedMessages();
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
          session = existingSession;
        } else {
          session = await this.conversationClient?.createSession();

          // Clear messages since we're starting fresh
          this.messages = [];
          this.messageHistory = [];
          this.formattedMessages = [];
          this.seenPartKeys.clear();
        }
      } else {
        session = await this.conversationClient?.createSession();
        // Clear notification tracking for new conversation
        this.notifiedSessions.clear();
        this.waitingForAtlasResponse = false;
        this.currentSessionForNotification = null;
        this.currentConversationId = null;
        this.messageHistory = [];
        this.formattedMessages = [];
        this.seenPartKeys.clear();
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

        // Track sessions and messages in this batch
        let currentBatchSessionId: string | null = null;
        let sessionFinishing: string | null = null;

        // Check what's in this message batch
        let isTyping = this.typingState.isTyping;

        uiMessage.parts.forEach((part) => {
          if (part.type === "data-session-start") {
            const sessionId = part.data.sessionId;
            this.atlasSessionId = sessionId;
            currentBatchSessionId = sessionId;
            isTyping = true;
          } else if (part.type === "data-user-message" && part.data) {
            if (currentBatchSessionId) {
              // Check if this is a NEW session we haven't notified for yet
              if (!this.notifiedSessions.has(currentBatchSessionId)) {
                this.notifiedSessions.add(currentBatchSessionId);
                this.currentSessionForNotification = currentBatchSessionId;
                this.waitingForAtlasResponse = true;
              }
            }
          } else if (part.type === "data-session-finish") {
            sessionFinishing = this.atlasSessionId;
            isTyping = false;
            this.atlasSessionId = null;
          } else if (part.type === "text" && (part as { state?: string }).state === "done") {
            isTyping = false;
          } else if (part.type === "data-session-cancel") {
            // Store the session ID before clearing it
            const cancelledSessionId = this.atlasSessionId;
            isTyping = false;
            this.atlasSessionId = null;
            if (this.currentSessionForNotification === cancelledSessionId) {
              this.waitingForAtlasResponse = false;
              this.currentSessionForNotification = null;
            }
          } else if (part.type === "data-error" || part.type === "data-agent-error") {
            // Ensure progress indicators stop when an error occurs
            isTyping = false;
            this.atlasSessionId = null;
            if (this.currentSessionForNotification) {
              this.waitingForAtlasResponse = false;
              this.currentSessionForNotification = null;
            }
          }

          if (!this.isEphemeralPart(part)) {
            this.persistPart(part);
          }
        });

        this.typingState.isTyping = isTyping;

        // Handle session finish - check if we need to send notification
        if (
          sessionFinishing &&
          sessionFinishing === this.currentSessionForNotification &&
          this.waitingForAtlasResponse &&
          !this.windowFocused &&
          this.notificationPermissionGranted
        ) {
          // Clear the flag to prevent repeated notifications
          this.waitingForAtlasResponse = false;
          this.currentSessionForNotification = null;
          this.sendResponseNotification().catch(console.error);
        } else if (
          sessionFinishing &&
          sessionFinishing === this.currentSessionForNotification &&
          this.waitingForAtlasResponse
        ) {
          // Clear the flag since we've handled this response
          this.waitingForAtlasResponse = false;
          this.currentSessionForNotification = null;
        }
        const transientParts: SessionUIMessagePart[] = [];

        for (const part of uiMessage.parts) {
          try {
            const key = this.getPartKey(part);
            if (!this.seenPartKeys.has(key)) {
              transientParts.push(part);
            }
          } catch {
            transientParts.push(part);
          }
        }

        this.messages = transientParts;
        this.refreshFormattedMessages();
      }

      // If we reached here and the abort signal wasn't triggered,
      // it means the SSE stream ended unexpectedly (daemon likely stopped)
      if (this.sseAbortController && !this.sseAbortController.signal.aborted) {
        this.daemonStatus = "error";
        this.isSetupComplete = false;
        // Keep health checks running and preserve session to reconnect
        this.cleanup(false, true);
        // Ensure health checks and countdown are running
        if (this.healthCheckInterval === null) {
          this.startHealthCheckInterval();
        }
      }
    } catch {
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
      const isDaemonHealthy = await parseResult(client.health.index.$get());

      if (isDaemonHealthy.ok) {
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
      this.messageHistory = [];
      this.formattedMessages = [];
      this.seenPartKeys.clear();
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

    // Clear notification tracking when switching conversations
    if (this.currentConversationId !== id) {
      this.notifiedSessions.clear();
      this.waitingForAtlasResponse = false;
      this.currentSessionForNotification = null;
      this.currentConversationId = id;
    }

    const res = await parseResult(
      client.chatStorage[":streamId"].$get({ param: { streamId: id } }),
    );
    if (res.ok) {
      const history: SessionUIMessagePart[] = res.data.messages.flatMap((message) => message.parts);
      this.messageHistory = history;
      this.seenPartKeys.clear();
      for (const part of history) {
        this.seenPartKeys.add(this.getPartKey(part));
      }
      this.refreshFormattedMessages();
    }
  }

  private persistPart(part: SessionUIMessagePart) {
    try {
      const key = this.getPartKey(part);
      if (this.seenPartKeys.has(key)) {
        return;
      }

      this.seenPartKeys.add(key);
      this.messageHistory = [...this.messageHistory, structuredClone(part)];
      this.refreshFormattedMessages();
    } catch {
      // Silent fail - part won't be persisted
    }
  }

  private refreshFormattedMessages() {
    try {
      const formatted: OutputEntry[] = [];

      for (const part of this.messageHistory) {
        const entry = formatMessage(part, this.user);
        if (entry) {
          // Keep the ID from formatMessage which generates proper UUIDs
          formatted.push(entry);
        }
      }

      this.formattedMessages = formatted;
    } catch {
      // Silent fail - formatted messages will be empty
    }
  }

  private isEphemeralPart(part: SessionUIMessagePart): boolean {
    const ephemeralTypes = new Set([
      "data-connection",
      "data-heartbeat",
      "data-tool-progress",
      "data-session-start",
      "data-session-finish",
      "data-session-cancel",
      "data-agent-start",
      "data-agent-finish",
    ]);

    if (ephemeralTypes.has(part.type)) {
      return true;
    }

    if (part.type.startsWith("tool-result-")) {
      return true;
    }

    if (part.type === "text") {
      return "state" in part && part.state !== "done";
    }

    if (part.type === "reasoning") {
      return "state" in part && part.state !== "done";
    }

    return false;
  }

  private getPartKey(part: SessionUIMessagePart): string {
    // If part has an ID, use it as the key
    if ("id" in part && part.id) {
      return String(part.id);
    }

    // For text-based parts, use type + text as key
    if ("text" in part && part.text) {
      return `${part.type}:${part.text}`;
    }

    // For data-based parts, stringify the data
    if ("data" in part && part.data) {
      return `${part.type}:${JSON.stringify(part.data)}`;
    }

    // For simple parts, just use the type
    return part.type;
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
