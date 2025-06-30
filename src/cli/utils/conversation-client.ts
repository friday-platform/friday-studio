import { createEventSource } from "../../core/agents/remote/adapters/sse-utils.ts";
import type { ConversationEvent } from "../../core/conversation-supervisor.ts";

export interface ConversationSession {
  sessionId: string;
  mode: "private" | "shared";
  participants: Array<{
    userId: string;
    clientType: string;
    joinedAt: string;
    lastSeen: string;
  }>;
  sseUrl: string;
}

export interface ConversationMessage {
  messageId: string;
  status: "processing" | "completed" | "error";
}

/**
 * Client for communicating with Atlas daemon conversation API
 * Handles HTTP requests and SSE streaming for real-time chat experience
 */
export class ConversationClient {
  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string = "atlas-user",
  ) {}

  /**
   * Create a new conversation session
   */
  async createSession(mode: "private" | "shared" = "private"): Promise<ConversationSession> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          metadata: {
            userId: this.userId,
            clientType: "atlas-cli",
            capabilities: ["streaming", "transparency"],
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Failed to create conversation session (${response.status}): ${errorText}`,
      );
    }

    return await response.json();
  }

  /**
   * Send a message to the conversation session
   */
  async sendMessage(sessionId: string, message: string): Promise<ConversationMessage> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          fromUser: this.userId,
          timestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Stream conversation events via Server-Sent Events
   */
  async *streamEvents(sessionId: string): AsyncIterableIterator<ConversationEvent> {
    const sseUrl =
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}/stream`;

    try {
      const eventSource = await createEventSource({ url: sseUrl });

      for await (const message of eventSource.consume()) {
        try {
          const event: ConversationEvent = {
            type: (message.event || "unknown") as ConversationEvent["type"],
            data: JSON.parse(message.data),
            timestamp: new Date().toISOString(),
            sessionId,
            messageId: message.id,
          };

          yield event;
        } catch (error) {
          console.error("Failed to parse SSE message:", error, message);
          // Continue processing other messages
        }
      }
    } catch (error) {
      throw new Error(
        `SSE connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get session information
   */
  async getSession(sessionId: string): Promise<ConversationSession | null> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Check if daemon is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.daemonUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get workspace information to verify workspace exists
   */
  async getWorkspace(): Promise<{ id: string; name: string; status: string }> {
    const response = await fetch(`${this.daemonUrl}/api/workspaces/${this.workspaceId}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Workspace API error (${response.status}): ${errorText}`);
    }

    return await response.json();
  }
}
