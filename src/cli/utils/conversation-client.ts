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
  public sseUrl?: string; // Store the SSE URL from createSession

  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string = "atlas-user",
  ) {}

  /**
   * Create a new conversation session using the system workspace
   */
  async createSession(mode: "private" | "shared" = "private"): Promise<ConversationSession> {
    // Use the new system workspace endpoint for conversations
    const url = `${this.daemonUrl}/system/conversation/stream`;
    // Create session without sending an initial message
    const body = {
      userId: this.userId,
      scope: {
        workspaceId: this.workspaceId,
      },
      createOnly: true, // Just create session, don't send a message
    };

    console.log(`[ConversationClient] Creating session at ${url} with body:`, body);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      console.error(`[ConversationClient] Failed to create session:`, {
        status: response.status,
        statusText: response.statusText,
        errorText,
        url,
        body,
      });
      throw new Error(
        `Failed to create conversation session (${response.status}): ${errorText}`,
      );
    }

    const result = await response.json();
    console.log(`[ConversationClient] Session created successfully:`, result);

    // Transform the response to match the expected ConversationSession interface
    return {
      sessionId: result.session_id,
      mode,
      participants: [{
        userId: this.userId,
        clientType: "atlas-cli",
        joinedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      }],
      sseUrl: `${this.daemonUrl}${result.response_channel.url}`,
    };
  }

  /**
   * Send a message to the conversation session
   */
  async sendMessage(sessionId: string, message: string): Promise<ConversationMessage> {
    // For the new system workspace, we trigger a new signal with the session ID
    const response = await fetch(
      `${this.daemonUrl}/system/conversation/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          userId: this.userId,
          sessionId: sessionId, // Use the existing session ID
          createOnly: false, // Explicitly set to false for message sending
          scope: {
            workspaceId: this.workspaceId,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    // Update the SSE URL if a new session was created
    if (result.session_id) {
      this.sseUrl = `${this.daemonUrl}/system/conversation/sessions/${result.session_id}/stream`;
    }

    // Return a message object with the new session info
    return {
      messageId: crypto.randomUUID(),
      status: "processing",
    };
  }

  /**
   * Stream conversation events via Server-Sent Events
   */
  async *streamEvents(
    sessionId: string,
    sseUrl?: string,
  ): AsyncIterableIterator<ConversationEvent> {
    // Use the SSE URL from the session if not provided
    const streamUrl = sseUrl ||
      `${this.daemonUrl}/system/conversation/sessions/${sessionId}/stream`;

    let eventSource: any = null;
    try {
      eventSource = await createEventSource({ url: streamUrl });

      for await (const message of eventSource.consume()) {
        try {
          const parsedData = JSON.parse(message.data);
          const event: ConversationEvent = {
            type: parsedData.type || "unknown" as ConversationEvent["type"],
            data: parsedData.data || parsedData,
            timestamp: parsedData.timestamp || new Date().toISOString(),
            sessionId: parsedData.sessionId || sessionId,
            messageId: message.id,
          };

          yield event;

          // Close the connection after message_complete
          if (event.type === "message_complete") {
            if (eventSource && eventSource.close) {
              eventSource.close();
            }
            break;
          }
        } catch (error) {
          console.error("Failed to parse SSE message:", error, message);
          // Continue processing other messages
        }
      }
    } catch (error) {
      throw new Error(
        `SSE connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Ensure the connection is closed
      if (eventSource && eventSource.close) {
        eventSource.close();
      }
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
