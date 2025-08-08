import { createEventSource } from "../../core/agents/remote/adapters/sse-utils.ts";
import { createAtlasClient, type paths } from "@atlas/oapi-client";
import { DaemonClient } from "./daemon-client.ts";

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
  private daemonClient: DaemonClient;
  private conversationWorkspaceId?: string; // Cache the conversation workspace ID

  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string = "atlas-user",
  ) {
    this.daemonClient = new DaemonClient({ daemonUrl });
  }

  /**
   * Create a new conversation session using direct daemon API
   */
  async createSession(options?: {
    userId?: string;
    scope?: { workspaceId?: string };
    createOnly?: boolean;
  }): Promise<ConversationSession> {
    // Use the new direct daemon stream API
    const url = `${this.daemonUrl}/api/streams`;
    // Create session without sending an initial message
    const body = {
      userId: options?.userId || this.userId,
      scope: options?.scope || {
        workspaceId: this.workspaceId,
      },
      createOnly: options?.createOnly ?? true, // Just create session, don't send a message
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Failed to create conversation session (${response.status}): ${errorText}`,
      );
    }

    const result = await response.json();

    // Transform the response to match the expected ConversationSession interface
    return {
      sessionId: result.stream_id,
      mode: "private",
      participants: [
        {
          userId: this.userId,
          clientType: "atlas-cli",
          joinedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      ],
      sseUrl: `${this.daemonUrl}${result.sse_url}`,
    };
  }

  /**
   * Find the conversation workspace ID by looking for workspace with name "conversation"
   */
  private async getConversationWorkspaceId(): Promise<string> {
    if (this.conversationWorkspaceId) {
      return this.conversationWorkspaceId;
    }

    try {
      const workspaces = await this.daemonClient.listWorkspaces();
      const conversationWorkspace = workspaces.find(
        (w) => w.id === "atlas-conversation",
      );

      if (!conversationWorkspace) {
        throw new Error(
          "Conversation workspace not found - install conversation workspace to use chat features",
        );
      }

      this.conversationWorkspaceId = conversationWorkspace.id;
      return this.conversationWorkspaceId;
    } catch (error) {
      throw new Error(`Failed to find conversation workspace: ${error}`);
    }
  }

  /**
   * Send a message to the conversation session using workspace signals
   */
  async sendMessage(
    sessionId: string,
    message: string,
    conversationId?: string,
    type: "user" | "system" | "error" = "user",
  ): Promise<ConversationMessage> {
    // Get the conversation workspace ID
    const workspaceId = await this.getConversationWorkspaceId();
    const client = createAtlasClient();

    const response = await client.POST(
      "/api/workspaces/{workspaceId}/signals/{signalId}",
      {
        params: { path: { workspaceId, signalId: "conversation-stream" } },
        body: {
          streamId: sessionId,
          payload: {
            streamId: sessionId,
            message,
            userId: this.userId,
            type,
            ...(conversationId && { conversationId }), // Include conversationId if provided
          },
        },
      },
    );

    if (response.error) {
      throw new Error(
        `Failed to send message (${response.response.status}): ${response.error.error}`,
      );
    }

    return {
      messageId: response.data.message || crypto.randomUUID(),
      status: "processing",
    };
  }

  /**
   * Send precomposed prompt to the conversation session using workspace signals
   */
  async sendPrompt(
    sessionId: string,
    parameters: {
      promptName: string;
    } & Record<string, unknown>,
  ): Promise<ConversationMessage> {
    // Get the conversation workspace ID
    const workspaceId = await this.getConversationWorkspaceId();
    const client = createAtlasClient();

    const response = await client.POST(
      "/api/workspaces/{workspaceId}/signals/{signalId}",
      {
        params: { path: { workspaceId, signalId: "conversation-stream" } },
        body: {
          streamId: sessionId,
          payload: {
            type: "prompt",
            streamId: sessionId,
            parameters,
          },
        },
      },
    );

    if (response.error) {
      throw new Error(
        `Failed to send message (${response.response.status}): ${response.error.error}`,
      );
    }

    return {
      messageId: response.data.message || crypto.randomUUID(),
      status: "processing",
    };
  }

  /**
   * Stream conversation events via Server-Sent Events
   * @FIXME: Create a dedicated event type from
   * https://github.com/tempestteam/atlas/blob/db7941f26370ca923ef4ede1d026386b765d028e/src/core/daemon-capabilities.ts#L104
   */
  async *streamEvents(
    sessionId: string,
    sseUrl?: string,
    abortSignal?: AbortSignal,
  ): AsyncIterableIterator<unknown> {
    // Use the SSE URL from the session if not provided
    const streamUrl = sseUrl ||
      `${this.daemonUrl}/system/conversation/sessions/${sessionId}/stream`;

    let eventSource: any = null;
    try {
      eventSource = await createEventSource({
        url: streamUrl,
        options: abortSignal ? { signal: abortSignal } : undefined,
      });

      for await (const message of eventSource.consume()) {
        // Check if aborted
        if (abortSignal?.aborted) {
          break;
        }

        try {
          const parsedData = JSON.parse(message.data);
          const event: unknown = {
            type: parsedData.type || "unknown",
            data: parsedData.data || parsedData,
            timestamp: parsedData.timestamp || new Date().toISOString(),
            sessionId: parsedData.sessionId || sessionId,
            messageId: message.id,
            id: parsedData.id,
          };

          yield event;

          // Only close the connection if explicitly requested
          if (
            // @ts-expect-error event is currently untyped
            event.type === "message_complete" &&
            // @ts-expect-error event is currently untyped
            event.data?.closeConnection === true
          ) {
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
      // Handle specific connection errors with user-friendly messages
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for daemon shutdown or connection loss
      if (
        errorMessage.includes("error reading a body from connection") ||
        errorMessage.includes("Connection refused") ||
        errorMessage.includes("ECONNREFUSED")
      ) {
        throw new Error(
          "Connection to Atlas daemon lost. The daemon may have been stopped or restarted.",
        );
      }

      // Check for network issues
      if (
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("ERR_NETWORK")
      ) {
        throw new Error(
          "Network connection to Atlas daemon failed. Please check your network and daemon status.",
        );
      }

      // Default error message for other cases
      throw new Error(
        `SSE connection error: ${errorMessage}`,
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
      throw new Error(
        `Failed to get session: ${response.status} ${response.statusText}`,
      );
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
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}`,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Workspace API error (${response.status}): ${errorText}`);
    }

    return await response.json();
  }
}
