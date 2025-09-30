import { client, parseResult } from "@atlas/client/v2";
import type { SessionUIMessageChunk } from "@atlas/core";
import { throwWithCause } from "@atlas/core/errors";
import { logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { createEventSource } from "eventsource-client";

interface ConversationSession {
  sessionId: string;
  mode: "private" | "shared";
  participants: Array<{ userId: string; clientType: string; joinedAt: string; lastSeen: string }>;
  sseUrl: string;
}

interface ConversationMessage {
  messageId: string;
  status: "processing" | "completed" | "error";
}

/**
 * Client for communicating with Atlas daemon conversation API
 * Handles HTTP requests and SSE streaming for real-time chat experience
 */
export class ConversationClient {
  public sseUrl?: string; // Store the SSE URL from createSession
  private conversationWorkspaceId?: string; // Cache the conversation workspace ID
  private client = createAtlasClient();

  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string = "atlas-user",
  ) {}

  /**
   * Create a new conversation session using direct daemon API
   */
  async createSession(options?: {
    userId?: string;
    scope?: { workspaceId?: string };
    createOnly?: boolean;
  }): Promise<ConversationSession> {
    const res = await this.client.POST("/api/sse", {
      body: {
        userId: options?.userId || this.userId,
        scope: options?.scope || { workspaceId: this.workspaceId },
        createOnly: options?.createOnly ?? true, // Just create session, don't send a message
      },
    });
    if (res.error) {
      const errorMessage = res.error.error || "Failed to create conversation session";
      if (errorMessage.includes("401")) {
        throwWithCause(
          "Authentication failed. Please check your API key configuration.",
          errorMessage,
        );
      } else if (errorMessage.includes("ECONNREFUSED")) {
        throwWithCause(
          "Cannot connect to Atlas daemon. Please ensure it is running.",
          errorMessage,
        );
      }
      throwWithCause("Failed to create conversation session. Please try again.", errorMessage);
    }
    // Transform the response to match the expected ConversationSession interface
    return {
      sessionId: res.data.stream_id,
      mode: "private",
      participants: [
        {
          userId: this.userId,
          clientType: "atlas-cli",
          joinedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      ],
      sseUrl: `${this.daemonUrl}${res.data.sse_url}`,
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
      const workspaces = await parseResult(client.workspace.index.$get());
      if (!workspaces.ok) {
        throw new Error(`Failed to fetch workspaces: ${workspaces.error}`);
      }
      const conversationWorkspace = workspaces.data.find((w) => w.id === "atlas-conversation");
      if (!conversationWorkspace) {
        throwWithCause(
          "Conversation workspace not found. Please install the conversation workspace to use chat features.",
          {
            type: "unknown",
            code: "WORKSPACE_ATLAS_CONVERSATION_NOT_FOUND_IN_AVAILABLE_WORKSPACES",
          },
        );
      }

      this.conversationWorkspaceId = conversationWorkspace.id;
      return this.conversationWorkspaceId;
    } catch (error) {
      throwWithCause(
        "Failed to locate conversation workspace. Please check your workspace configuration.",
        error,
      );
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

    const response = await client.POST("/api/workspaces/{workspaceId}/signals/{signalId}", {
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
    });

    if (response.error) {
      const status = response.response?.status || 0;
      const errorMessage = response.error.error || "Unknown error";

      if (status === 429) {
        throwWithCause(
          "Rate limit exceeded. Please wait a moment before sending another message.",
          errorMessage,
        );
      } else if (status >= 500) {
        throwWithCause(
          "Atlas service is temporarily unavailable. Please try again later.",
          errorMessage,
        );
      }

      throwWithCause("Failed to send message. Please try again.", `${status}: ${errorMessage}`);
    }

    return { messageId: response.data.message || crypto.randomUUID(), status: "processing" };
  }

  /**
   * Send precomposed prompt to the conversation session using workspace signals
   */
  async sendPrompt(
    sessionId: string,
    parameters: { promptName: string } & Record<string, unknown>,
  ): Promise<ConversationMessage> {
    // Get the conversation workspace ID
    const workspaceId = await this.getConversationWorkspaceId();
    const client = createAtlasClient();

    const response = await client.POST("/api/workspaces/{workspaceId}/signals/{signalId}", {
      params: { path: { workspaceId, signalId: "conversation-stream" } },
      body: { streamId: sessionId, payload: { type: "prompt", streamId: sessionId, parameters } },
    });

    if (response.error) {
      const status = response.response?.status || 0;
      const errorMessage = response.error.error || "Unknown error";

      if (status === 429) {
        throwWithCause(
          "Rate limit exceeded. Please wait a moment before sending another message.",
          errorMessage,
        );
      } else if (status >= 500) {
        throwWithCause(
          "Atlas service is temporarily unavailable. Please try again later.",
          errorMessage,
        );
      }

      throwWithCause("Failed to send message. Please try again.", `${status}: ${errorMessage}`);
    }

    return { messageId: response.data.message || crypto.randomUUID(), status: "processing" };
  }

  /**
   * Stream conversation events via Server-Sent Events
   */
  async *streamEvents(
    sessionId: string,
    sseUrl: string,
    abortSignal?: AbortSignal,
  ): AsyncIterableIterator<SessionUIMessageChunk> {
    try {
      const eventSource = createEventSource(sseUrl);
      for await (const { data, id } of eventSource) {
        if (abortSignal?.aborted) {
          break;
        }

        try {
          const parsedData = JSON.parse(data);
          const event: unknown = {
            type: parsedData.type || "unknown",
            data: parsedData.data || parsedData,
            timestamp: parsedData.timestamp || new Date().toISOString(),
            sessionId: parsedData.sessionId || sessionId,
            messageId: id,
            id: parsedData.id,
          };

          logger.debug("SSE data received", { data, sessionId });
          yield event;
        } catch (error) {
          logger.error("Failed to parse SSE message", { error, data, sessionId });
          // Continue processing other messages
        }
      }
    } catch (error) {
      // Handle specific connection errors with user-friendly messages
      const message = stringifyError(error);

      // Check for daemon shutdown or connection loss
      if (
        message.includes("error reading a body from connection") ||
        message.includes("Connection refused") ||
        message.includes("ECONNREFUSED")
      ) {
        throwWithCause(
          "Connection to Atlas daemon lost. Please check if the daemon is running.",
          error,
        );
      }

      // Check for network issues
      if (
        message.includes("Failed to fetch") ||
        message.includes("NetworkError") ||
        message.includes("ERR_NETWORK")
      ) {
        throwWithCause(
          "Network connection to Atlas daemon failed. Please check your network and daemon status.",
          error,
        );
      }

      // Default error message for other cases
      throwWithCause("Streaming connection error. Please try reconnecting.", error);
    }
  }

  createMessageStream(
    sseUrl: string,
    sessionId: string,
    _abortSignal?: AbortSignal,
  ): ReadableStream<SessionUIMessageChunk> {
    const eventSource = createEventSource(sseUrl);

    return new ReadableStream<SessionUIMessageChunk>({
      start(controller) {
        // Start consuming the async iterator in the background
        (async () => {
          try {
            for await (const { data } of eventSource) {
              try {
                const parsedData = JSON.parse(data);
                controller.enqueue(parsedData);
              } catch (error) {
                // Skip malformed messages, don't break the stream
                logger.error("Failed to parse SSE message in stream", { error, data, sessionId });
              }
            }
          } catch (error) {
            controller.error(error);
          }
        })();
      },

      cancel() {
        // Clean up on stream cancellation
        eventSource.close();
      },
    });
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
      throwWithCause(
        `Failed to retrieve session information. Status: ${response.status}`,
        response.statusText,
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
    const response = await fetch(`${this.daemonUrl}/api/workspaces/${this.workspaceId}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      switch (response.status) {
        case 404:
          throwWithCause("Workspace not found. Please check the workspace ID.", errorText);
        case 403:
          throwWithCause("Permission denied. You don't have access to this workspace.", errorText);
        default:
          throwWithCause(`Failed to access workspace. Status: ${response.status}`, errorText);
      }
    }

    return await response.json();
  }

  /**
   * Cancel an active Atlas session
   */
  async cancelSession(sessionId: string): Promise<void> {
    const client = createAtlasClient();
    const response = await client.DELETE("/api/sessions/{sessionId}", {
      params: { path: { sessionId } },
    });

    // Ignore 404 errors (session already finished)
    if (response.error && response.response.status !== 404) {
      throwWithCause(
        "Failed to cancel session. The session may have already ended.",
        response.error.error || "Unknown error",
      );
    }
  }
}
