// import {
//   createEventSource,
//   EventSourceMessage,
// } from "../../core/agents/remote/adapters/sse-utils.ts";

import type { SessionUIMessageChunk } from "@atlas/core";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { createEventSource } from "eventsource-client";
import { DaemonClient } from "./daemon-client.ts";

export interface ConversationSession {
  sessionId: string;
  mode: "private" | "shared";
  participants: Array<{ userId: string; clientType: string; joinedAt: string; lastSeen: string }>;
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
  private client = createAtlasClient();

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
    const res = await this.client.POST("/api/sse", {
      body: {
        userId: options?.userId || this.userId,
        scope: options?.scope || { workspaceId: this.workspaceId },
        createOnly: options?.createOnly ?? true, // Just create session, don't send a message
      },
    });
    if (res.error) {
      throw new Error(`Failed to create conversation session (${res.error}): ${res.error.error}`);
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
      const workspaces = await this.daemonClient.listWorkspaces();
      const conversationWorkspace = workspaces.find((w) => w.id === "atlas-conversation");

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
      throw new Error(
        `Failed to send message (${response.response.status}): ${response.error.error}`,
      );
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
      throw new Error(
        `Failed to send message (${response.response.status}): ${response.error.error}`,
      );
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

          console.log("Data: %s", data);
          yield event;
        } catch (error) {
          console.error("💩💩💩", error);
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
        throw new Error("Connection to Atlas daemon lost. It may have been stopped or restarted.");
      }

      // Check for network issues
      if (
        message.includes("Failed to fetch") ||
        message.includes("NetworkError") ||
        message.includes("ERR_NETWORK")
      ) {
        throw new Error(
          "Network connection to Atlas daemon failed. Please check your network and daemon status.",
        );
      }

      // Default error message for other cases
      throw new Error(`SSE connection error: ${message}`);
    }

    // Use the SSE URL from the session if not provided

    // let eventSource: {
    //   response: Response;
    //   consume(): AsyncIterableIterator<EventSourceMessage>;
    // } | null = null;

    // try {
    //   eventSource = await createEventSource({
    //     url: sseUrl,
    //     options: abortSignal ? { signal: abortSignal } : undefined,
    //   });

    //   for await (const message of eventSource.consume()) {
    //     // Check if aborted
    //     if (abortSignal?.aborted) {
    //       break;
    //     }

    //     console.log("🍂🍂🍂🍂", message.data);

    //     try {
    //       const parsedData = JSON.parse(message.data);
    //       const event: unknown = {
    //         type: parsedData.type || "unknown",
    //         data: parsedData.data || parsedData,
    //         timestamp: parsedData.timestamp || new Date().toISOString(),
    //         sessionId: parsedData.sessionId || sessionId,
    //         messageId: message.id,
    //         id: parsedData.id,
    //       };

    //       yield event;

    //       // Only close the connection if explicitly requested
    //       if (
    //         // @ts-expect-error event is currently untyped
    //         event.type === "message_complete" &&
    //         // @ts-expect-error event is currently untyped
    //         event.data?.closeConnection === true
    //       ) {
    //         // @TODO: cleanup: ensure the connection is closed
    //         break;
    //       }
    //     } catch (error) {
    //       console.error("Failed to parse SSE message:", error, message);
    //       // Continue processing other messages
    //     }
    //   }
    // } catch (error) {
    //   // Handle specific connection errors with user-friendly messages
    //   const errorMessage = error instanceof Error ? error.message : String(error);

    //   // Check for daemon shutdown or connection loss
    //   if (
    //     errorMessage.includes("error reading a body from connection") ||
    //     errorMessage.includes("Connection refused") ||
    //     errorMessage.includes("ECONNREFUSED")
    //   ) {
    //     throw new Error(
    //       "Connection to Atlas daemon lost. The daemon may have been stopped or restarted.",
    //     );
    //   }

    //   // Check for network issues
    //   if (
    //     errorMessage.includes("Failed to fetch") ||
    //     errorMessage.includes("NetworkError") ||
    //     errorMessage.includes("ERR_NETWORK")
    //   ) {
    //     throw new Error(
    //       "Network connection to Atlas daemon failed. Please check your network and daemon status.",
    //     );
    //   }

    //   // Default error message for other cases
    //   throw new Error(`SSE connection error: ${errorMessage}`);
    // } finally {
    //   // @TODO: cleanup: ensure the connection is closed
    // }
  }

  createMessageStream(
    sseUrl: string,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): ReadableStream<SessionUIMessageChunk> {
    const eventSource = createEventSource(sseUrl);

    return new ReadableStream<SessionUIMessageChunk>({
      start(controller) {
        // Start consuming the async iterator in the background
        (async () => {
          try {
            for await (const { data, id } of eventSource) {
              // if (abortSignal?.aborted) {
              //   controller.close();
              //   break;
              // }

              try {
                const parsedData = JSON.parse(data);
                // const event: SessionUIMessageChunk = {
                //   type: parsedData.type || "unknown",
                //   data: parsedData.data || parsedData,
                //   timestamp: parsedData.timestamp || new Date().toISOString(),
                //   sessionId: parsedData.sessionId || sessionId,
                //   messageId: id,
                //   id: parsedData.id,
                // };

                controller.enqueue(parsedData);
              } catch (error) {
                // Skip malformed messages, don't break the stream
                console.error("Parse error:", error);
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
      throw new Error(`Failed to cancel session: ${response.error.error}`);
    }
  }
}
