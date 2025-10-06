import { client, DetailedError, parseResult } from "@atlas/client/v2";
import type { SessionUIMessageChunk } from "@atlas/core";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { createEventSource } from "eventsource-client";

export interface ConversationSession {
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
  private conversationWorkspaceId?: string; // Cache the conversation workspace ID

  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string = "atlas-user",
  ) {}

  /**
   * Create a new conversation session using direct daemon API
   */
  async createSession(streamId?: string): Promise<ConversationSession> {
    const client = createAtlasClient();
    const response = await client.POST("/api/sse", {
      headers: { "Access-Control-Allow-Origin": "*" },
      body: {
        userId: this.userId,
        scope: { workspaceId: this.workspaceId },
        createOnly: true, // Just create session, don't send a message
        streamId,
      },
    });

    if (response.error) {
      throw new Error("Failed to create SSE stream", { cause: response.error });
    }

    // Transform the response to match the expected ConversationSession interface
    return {
      sessionId: response.data.stream_id,
      mode: "private",
      participants: [
        {
          userId: this.userId,
          clientType: "atlas-cli",
          joinedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      ],
      sseUrl: `${this.daemonUrl}${response.data.sse_url}`,
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

    const response = await parseResult(
      client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId: "conversation-stream" },
        json: {
          streamId: sessionId,
          payload: {
            streamId: sessionId,
            message,
            userId: this.userId,
            type,
            ...(conversationId && { conversationId }), // Include conversationId if provided
          },
        },
      }),
    );

    if (!response.ok) {
      if (response.error instanceof DetailedError) {
        if (response.error.statusCode === 429) {
          throw new Error(
            "Rate limit exceeded. Please wait a moment before sending another message.",
            { cause: response.error },
          );
        } else if (response.error.statusCode >= 500) {
          throw new Error("Atlas service is temporarily unavailable. Please try again later.", {
            cause: response.error,
          });
        }
      }
      throw new Error("Failed to send message. Please try again.", { cause: response.error });
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

    const response = await parseResult(
      client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId: "conversation-stream" },
        json: { streamId: sessionId, payload: { type: "prompt", streamId: sessionId, parameters } },
      }),
    );

    if (!response.ok) {
      if (response.error instanceof DetailedError) {
        if (response.error.statusCode === 429) {
          throw new Error(
            "Rate limit exceeded. Please wait a moment before sending another message.",
            { cause: response.error },
          );
        } else if (response.error.statusCode >= 500) {
          throw new Error("Atlas service is temporarily unavailable. Please try again later.", {
            cause: response.error,
          });
        }
      }
      throw new Error("Failed to send message. Please try again.", { cause: response.error });
    }

    return { messageId: response.data.message || crypto.randomUUID(), status: "processing" };
  }

  createMessageStream(sseUrl: string): ReadableStream<SessionUIMessageChunk> {
    const eventSource = createEventSource(sseUrl);
    let closed = false;

    return new ReadableStream<SessionUIMessageChunk>({
      start(controller) {
        // Start consuming the async iterator in the background
        (async () => {
          try {
            for await (const { data } of eventSource) {
              // Check if stream is closed before attempting operations
              if (closed) {
                break;
              }

              try {
                const parsedData = JSON.parse(data);
                /**
                 * Explicit type assertion  - we're currently not validating UI Message chunks.
                 * @todo https://ai-sdk.dev/docs/reference/ai-sdk-core/validate-ui-messages#validateuimessages
                 */
                // @ts-expect-error see above
                controller.enqueue(parsedData);
              } catch (error) {
                // Skip malformed messages, don't break the stream
                console.error("Parse error:", error);
              }
            }
          } catch (error) {
            if (!closed) {
              controller.error(error);
              closed = true;
            }
          } finally {
            if (!closed) {
              controller.close();
              closed = true;
            }
          }
        })();
      },
      cancel() {
        // Mark as closed when stream is cancelled
        closed = true;
      },
    });
  }

  /**
   * Check if daemon is reachable
   */
  async healthCheck(): Promise<boolean> {
    const response = await parseResult(
      client.health.index.$get({ headers: { "Access-Control-Allow-Origin": "*" } }),
    );
    return response.ok;
  }

  /**
   * Get workspace information to verify workspace exists
   */
  async getWorkspace(): Promise<{ id: string; name: string; status: string }> {
    const response = await parseResult(
      client.workspace[":workspaceId"].$get(
        { param: { workspaceId: this.workspaceId } },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      ),
    );

    if (!response.ok) {
      throw new Error(`Failed to access workspace.`, { cause: response.error });
    }
    return response.data;
  }

  /**
   * Get workspace information to verify workspace exists
   */
  async getUser(): Promise<{ currentUser: string; success: boolean }> {
    const client = createAtlasClient();
    const response = await client.GET("/api/user", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
    if (response.error) {
      throw new Error(`Failed to fetch user information.`, { cause: response.error });
    }
    return { currentUser: response.data.user, success: response.data.success };
  }

  async getSession(sessionId: string): Promise<ConversationSession | null> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}`,
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status} ${response.statusText}`);
    }
    // @ts-expect-error this will be addressed during chat
    return await response.json();
  }

  /**
   * Cancel an active Atlas session
   */
  async cancelSession(sessionId: string): Promise<void> {
    const response = await parseResult(
      client.sessions[":id"].$delete(
        { param: { sessionId } },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      ),
    );
    if (!response.ok) {
      throw new Error(`Failed to cancel session: ${stringifyError(response.error)}`);
    }
  }
}
