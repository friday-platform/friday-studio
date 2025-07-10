/**
 * Daemon-level capabilities - global capabilities managed by the daemon
 * These are orthogonal to workspaces and handle daemon-level operations
 */

// In-memory conversation storage (temporary implementation)
interface ConversationMessage {
  messageId: string;
  userId?: string;
  content: string;
  timestamp: string;
  role: "user" | "assistant";
  metadata?: any;
}

class InMemoryConversationStorage {
  private static instance: InMemoryConversationStorage;
  private conversations = new Map<string, ConversationMessage[]>();

  static getInstance(): InMemoryConversationStorage {
    if (!this.instance) {
      this.instance = new InMemoryConversationStorage();
    }
    return this.instance;
  }

  async getConversationHistory(streamId: string) {
    const messages = this.conversations.get(streamId) || [];
    return { messages };
  }

  async saveMessage(streamId: string, message: ConversationMessage) {
    const messages = this.conversations.get(streamId) || [];
    messages.push(message);
    this.conversations.set(streamId, messages);
  }

  formatHistoryForContext(messages: ConversationMessage[]): string {
    return messages
      .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
      .join("\n");
  }
}

export interface DaemonCapability {
  id: string;
  name: string;
  description: string;
  category: "streaming" | "system" | "management";
  inputSchema?: any; // JSON Schema for input validation
  implementation: (context: DaemonExecutionContext, ...args: any[]) => Promise<any>;
}

export interface DaemonExecutionContext {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  daemon: any; // Reference to AtlasDaemon instance
  conversationId?: string;
}

export class DaemonCapabilityRegistry {
  private static capabilities = new Map<string, DaemonCapability>();
  private static initialized = false;
  private static daemonInstance: any = null;

  /**
   * Set the daemon instance for capability access
   */
  static setDaemonInstance(daemon: any): void {
    console.log(`[DaemonCapabilityRegistry] Setting daemon instance:`, !!daemon);
    this.daemonInstance = daemon;
    console.log(
      `[DaemonCapabilityRegistry] Daemon instance set successfully:`,
      !!this.daemonInstance,
    );
  }

  /**
   * Get the daemon instance
   */
  static getDaemonInstance(): any {
    console.log(`[DaemonCapabilityRegistry] Getting daemon instance:`, !!this.daemonInstance);
    return this.daemonInstance;
  }

  /**
   * Initialize built-in daemon capabilities
   */
  static initialize(): void {
    if (this.initialized) return;

    // Stream reply capability for streaming responses
    this.registerCapability({
      id: "stream_reply",
      name: "Stream Reply",
      description: "Send a streaming reply to a stream via SSE",
      category: "streaming",
      inputSchema: {
        type: "object",
        properties: {
          stream_id: {
            type: "string",
            description: "The stream ID to send the message to",
          },
          message: {
            type: "string",
            description: "The message content to stream",
          },
          metadata: {
            type: "object",
            description: "Optional metadata/transparency information",
            additionalProperties: true,
          },
          conversationId: {
            type: "string",
            description: "Optional conversation ID for conversation continuity",
          },
        },
        required: ["stream_id", "message"],
        additionalProperties: false,
      },
      implementation: async (
        context,
        ...args: any[]
      ) => {
        // Handle both parameter styles:
        // 1. Direct parameters: (stream_id, message, metadata, conversationId)
        // 2. Object parameters: ({ stream_id, message, metadata, conversationId })
        let stream_id: string;
        let message: string;
        let metadata: any;
        let conversationId: string | undefined;

        if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
          // Object style parameters
          const params = args[0];
          stream_id = params.stream_id;
          message = params.message;
          metadata = params.metadata;
          conversationId = params.conversationId;
        } else {
          // Direct parameters
          [stream_id, message, metadata, conversationId] = args;
        }

        // Use HTTP to emit SSE events via daemon API
        try {
          // Validate message
          if (!message) {
            console.error("[stream_reply] ERROR: No message provided", { args, stream_id });
            throw new Error("Message is required for stream_reply");
          }

          // Generate messageId for this response
          const messageId = crypto.randomUUID();

          // Stream the message word-by-word for realistic typing feel
          const words = message.split(" ");
          let content = "";

          for (let i = 0; i < words.length; i++) {
            content += (i > 0 ? " " : "") + words[i];

            const chunkEvent = {
              type: "message_chunk",
              data: {
                content,
                partial: i < words.length - 1,
                conversationId,
              },
              timestamp: new Date().toISOString(),
              messageId,
              sessionId: stream_id,
            };

            // Use HTTP to emit SSE event via daemon API

            try {
              const response = await fetch(`http://localhost:8080/api/stream/${stream_id}/emit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(chunkEvent),
              });

              if (!response.ok) {
                throw new Error(`SSE emit failed: ${response.status} ${response.statusText}`);
              }
            } catch (emitError) {
              throw emitError;
            }

            // Small delay for realistic typing feel
            // await new Promise((resolve) => setTimeout(resolve, 25));
          }

          // Send transparency/metadata if provided
          if (metadata) {
            const transparencyEvent = {
              type: "transparency",
              data: metadata,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId: stream_id,
            };

            try {
              const response = await fetch(`http://localhost:8080/api/stream/${stream_id}/emit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(transparencyEvent),
              });

              if (!response.ok) {
                throw new Error(`SSE emit failed: ${response.status} ${response.statusText}`);
              }
            } catch (emitError) {
              throw emitError;
            }
          }

          // Send completion event (don't close connection)
          console.log(`[stream_reply] Sending completion event`);
          const completionEvent = {
            type: "message_complete",
            data: {
              messageId,
              conversationId,
              complete: true,
              closeConnection: false,
            },
            timestamp: new Date().toISOString(),
            messageId,
            sessionId: stream_id,
          };

          try {
            const response = await fetch(`http://localhost:8080/api/stream/${stream_id}/emit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(completionEvent),
            });

            if (!response.ok) {
              throw new Error(`SSE emit failed: ${response.status} ${response.statusText}`);
            }
            console.log(`[stream_reply] Completion event emitted successfully`);
          } catch (emitError) {
            console.error(`[stream_reply] Failed to emit completion event:`, emitError);
            throw emitError;
          }

          console.log(`[stream_reply] SUCCESS: Completed streaming for message ID ${messageId}`);
          return {
            success: true,
            message: "Reply streamed successfully",
            conversationId,
            messageId,
            stream_id,
          };
        } catch (error) {
          console.error(`[stream_reply] ERROR: Stream operation failed:`, error);
          console.error(
            `[stream_reply] Error stack:`,
            error instanceof Error ? error.stack : "No stack trace",
          );
          return {
            success: false,
            error: "stream_send_failed",
            message: error instanceof Error ? error.message : String(error),
            conversationId,
            stream_id,
            details:
              "Failed to send streaming reply. This might be due to connection issues or invalid stream ID.",
          };
        }
      },
    });

    // Conversation storage capability for conversation agent to manage its own history
    this.registerCapability({
      id: "conversation_storage",
      name: "Conversation Storage",
      description: "Manage conversation history using stream_id as key",
      category: "system",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["load_history", "save_message"],
            description: "The storage action to perform",
          },
          stream_id: {
            type: "string",
            description: "The stream ID (conversation identifier)",
          },
          message: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
              userId: { type: "string" },
            },
            description: "Message to save (for save_message action)",
          },
        },
        required: ["action", "stream_id"],
        additionalProperties: false,
      },
      implementation: async (
        context,
        ...args: any[]
      ) => {
        // Handle both parameter styles
        let action: string;
        let stream_id: string;
        let message: { role: "user" | "assistant"; content: string; metadata?: any } | undefined;

        if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
          // Object style parameters
          const params = args[0];
          action = params.action;
          stream_id = params.stream_id;
          message = params.message;
        } else {
          // Direct parameters
          [action, stream_id, message] = args;
        }
        try {
          console.log(`[conversation_storage] ${action} for stream ${stream_id}`);

          // Use in-memory conversation storage
          const conversationStorage = InMemoryConversationStorage.getInstance();

          if (action === "load_history") {
            const history = await conversationStorage.getConversationHistory(stream_id);
            const messages = history?.messages || [];

            console.log(
              `[conversation_storage] Loaded ${messages.length} messages for stream ${stream_id}`,
            );

            return {
              success: true,
              messages,
              messageCount: messages.length,
              historyContext: messages.length > 0
                ? conversationStorage.formatHistoryForContext(messages)
                : "",
            };
          }

          if (action === "save_message" && message) {
            const messageObj = {
              messageId: crypto.randomUUID(),
              userId: message.metadata?.userId,
              content: message.content,
              timestamp: message.metadata?.timestamp || new Date().toISOString(),
              role: message.role,
              metadata: {
                streamId: stream_id,
                workspaceContext: context.workspaceId,
                ...message.metadata,
              },
            };

            await conversationStorage.saveMessage(stream_id, messageObj);

            console.log(
              `[conversation_storage] Saved ${message.role} message to stream ${stream_id}`,
            );

            return {
              success: true,
              messageId: messageObj.messageId,
              saved: true,
            };
          }

          return {
            success: false,
            error: "Invalid action or missing message data",
          };
        } catch (error) {
          console.error(`[conversation_storage] Error:`, error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    this.initialized = true;
  }

  /**
   * Register a new daemon capability
   */
  static registerCapability(capability: DaemonCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  /**
   * Get all available capabilities
   */
  static getAllCapabilities(): DaemonCapability[] {
    this.initialize();
    return Array.from(this.capabilities.values());
  }

  /**
   * Get capability by ID
   */
  static getCapability(id: string): DaemonCapability | undefined {
    this.initialize();
    return this.capabilities.get(id);
  }

  /**
   * Execute a capability
   */
  static async executeCapability(
    capabilityId: string,
    context: DaemonExecutionContext,
    ...args: any[]
  ): Promise<any> {
    this.initialize();

    console.log(`[DaemonCapabilityRegistry] Executing capability: ${capabilityId}`);
    console.log(`[DaemonCapabilityRegistry] Context:`, {
      sessionId: context.sessionId,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      hasDaemon: !!context.daemon,
      conversationId: context.conversationId,
    });
    console.log(`[DaemonCapabilityRegistry] Args:`, args);

    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      console.error(`[DaemonCapabilityRegistry] Unknown daemon capability: ${capabilityId}`);
      throw new Error(`Unknown daemon capability: ${capabilityId}`);
    }

    console.log(`[DaemonCapabilityRegistry] Found capability: ${capability.name}`);
    const startTime = Date.now();

    try {
      const result = await capability.implementation(context, ...args);
      const duration = Date.now() - startTime;
      console.log(
        `[DaemonCapabilityRegistry] Capability ${capabilityId} completed in ${duration}ms`,
      );
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `[DaemonCapabilityRegistry] Capability ${capabilityId} failed after ${duration}ms:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Reset registry (useful for testing)
   */
  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}
