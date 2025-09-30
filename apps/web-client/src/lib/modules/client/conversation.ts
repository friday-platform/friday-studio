import { client, parseResult } from "@atlas/client/v2";
import type { SessionUIMessageChunk } from "@atlas/core";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { createEventSource } from "eventsource-client";
import { DaemonClient } from "./daemon.ts";

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
  async createSession(streamId?: string): Promise<ConversationSession> {
    // Use the new direct daemon stream API
    const url = `${this.daemonUrl}/api/sse`;
    // Create session without sending an initial message
    const body = {
      userId: this.userId,
      scope: { workspaceId: this.workspaceId },
      createOnly: true, // Just create session, don't send a message
      streamId,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Failed to create conversation session (${response.status}): ${errorText}`);
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

  createMessageStream(sseUrl: string): ReadableStream<SessionUIMessageChunk> {
    const eventSource = createEventSource(sseUrl);

    return new ReadableStream<SessionUIMessageChunk>({
      start(controller) {
        let closed = false;

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
    try {
      const response = await fetch(`${this.daemonUrl}/health`, {
        headers: { "Access-Control-Allow-Origin": "*" },
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
    const response = await fetch(`${this.daemonUrl}/api/workspaces/${this.workspaceId}`, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Workspace API error (${response.status}): ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Get workspace information to verify workspace exists
   */
  async getUser(): Promise<{ currentUser: string; success: boolean }> {
    const response = await fetch(`${this.daemonUrl}/api/user`, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Workspace API error (${response.status}): ${errorText}`);
    }

    return await response.json();
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
      throw new Error(`Failed to cancel session: ${stringifyError(response.error.error)}`);
    }
  }
}
