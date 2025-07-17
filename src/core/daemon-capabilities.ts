/**
 * Daemon-level capabilities - global capabilities managed by the daemon
 * These are orthogonal to workspaces and handle daemon-level operations
 */

import { z } from "zod";
import { ValidationError } from "../utils/errors.ts";
import type { AtlasDaemon } from "../../apps/atlasd/src/atlas-daemon.ts";
import { Tool } from "ai";

const ConversationMessageSchema = z.object({
  messageId: z.string().uuid(),
  userId: z.string().optional(),
  content: z.string().min(1),
  timestamp: z.string().datetime(),
  role: z.enum(["user", "assistant"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

class InMemoryConversationStorage {
  private static instance: InMemoryConversationStorage;
  private conversations = new Map<string, ConversationMessage[]>();

  static getInstance(): InMemoryConversationStorage {
    if (!this.instance) {
      this.instance = new InMemoryConversationStorage();
    }
    return this.instance;
  }

  getConversationHistory(streamId: string) {
    const messages = this.conversations.get(streamId) || [];
    return { messages };
  }

  saveMessage(streamId: string, message: ConversationMessage) {
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
  // Direct AI SDK Tool factory method - follows MCP pattern
  toTool: (context: DaemonExecutionContext) => Tool;
}

export interface DaemonExecutionContext {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  daemon: AtlasDaemon;
  conversationId?: string;
  streams: {
    send: (streamId: string, event: {
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
      conversationId?: string;
    }) => Promise<void>;
  };
}

// Helper function to create streams implementation
export function createStreamsImplementation(): DaemonExecutionContext["streams"] {
  return {
    send: async (streamId: string, event: {
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
      conversationId?: string;
    }) => {
      const messageId = crypto.randomUUID();
      const { type, content, metadata, conversationId } = event;

      // Stream the message word-by-word for realistic typing feel
      const words = content.split(" ");
      let currentContent = "";

      for (let i = 0; i < words.length; i++) {
        currentContent += (i > 0 ? " " : "") + words[i];

        const chunkEvent = {
          type: "message_chunk",
          data: {
            content: currentContent,
            partial: i < words.length - 1,
            conversationId,
          },
          timestamp: new Date().toISOString(),
          messageId,
          sessionId: streamId,
        };

        try {
          const response = await fetch(`http://localhost:8080/api/stream/${streamId}/emit`, {
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
      }

      // Send metadata if provided
      if (metadata) {
        const transparencyEvent = {
          type: "transparency",
          data: metadata,
          timestamp: new Date().toISOString(),
          messageId,
          sessionId: streamId,
        };

        try {
          const response = await fetch(`http://localhost:8080/api/stream/${streamId}/emit`, {
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

      // Send completion event
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
        sessionId: streamId,
      };

      try {
        const response = await fetch(`http://localhost:8080/api/stream/${streamId}/emit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(completionEvent),
        });

        if (!response.ok) {
          throw new Error(`SSE emit failed: ${response.status} ${response.statusText}`);
        }
      } catch (emitError) {
        throw emitError;
      }
    },
  };
}

export class DaemonCapabilityRegistry {
  private static capabilities = new Map<string, DaemonCapability>();
  private static initialized = false;
  private static daemonInstance: AtlasDaemon | null = null;

  static setDaemonInstance(daemon: AtlasDaemon): void {
    console.log(`[DaemonCapabilityRegistry] Setting daemon instance:`, !!daemon);
    this.daemonInstance = daemon;
    console.log(
      `[DaemonCapabilityRegistry] Daemon instance set successfully:`,
      !!this.daemonInstance,
    );
  }

  static getDaemonInstance(): AtlasDaemon | null {
    console.log(`[DaemonCapabilityRegistry] Getting daemon instance:`, !!this.daemonInstance);
    return this.daemonInstance;
  }

  static initialize(): void {
    if (this.initialized) return;

    this.registerCapability({
      id: "stream_reply",
      name: "Stream Reply",
      description: "Send a streaming reply to a stream via SSE",
      category: "streaming",
      toTool: (context: DaemonExecutionContext): Tool => {
        return {
          description: "Send a streaming reply to a stream via SSE",
          parameters: z.object({
            stream_id: z.string().min(1).describe("Stream ID for the reply"),
            message: z.string().min(1).describe("Message content to stream"),
            metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
            conversationId: z.string().optional().describe("Optional conversation ID"),
          }),
          execute: async (args) => {
            // Validation already handled by AI SDK
            const { stream_id, message, metadata, conversationId } = args;

            // Execute with context closure - direct implementation
            await context.streams.send(stream_id, {
              type: "message",
              content: message,
              metadata,
              conversationId: conversationId || context.conversationId,
            });

            return { success: true, stream_id };
          },
        };
      },
    });

    this.registerCapability({
      id: "conversation_storage",
      name: "Conversation Storage",
      description: "Manage conversation history using stream_id as key",
      category: "system",
      toTool: (context: DaemonExecutionContext): Tool => {
        return {
          description: "Manage conversation history using stream_id as key",
          parameters: z.object({
            action: z.enum(["load_history", "save_message"]).describe("Action to perform"),
            stream_id: z.string().min(1).describe("Stream ID as the key for conversation history"),
            message: z.object({
              role: z.enum(["user", "assistant"]).describe("Role of the message sender"),
              content: z.string().min(1).describe("Content of the message"),
              userId: z.string().optional().describe("Optional user ID"),
              metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
            }).optional().describe("Message object for save_message action"),
          }),
          execute: async (args) => {
            // Validation already handled by AI SDK
            const { action, stream_id, message } = args;

            try {
              console.log(`[conversation_storage] ${action} for stream ${stream_id}`);

              const conversationStorage = InMemoryConversationStorage.getInstance();

              if (action === "load_history") {
                const history = conversationStorage.getConversationHistory(stream_id);
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
                const messageObj: ConversationMessage = {
                  messageId: crypto.randomUUID(),
                  userId: message.userId,
                  content: message.content,
                  timestamp: new Date().toISOString(),
                  role: message.role,
                  metadata: {
                    streamId: stream_id,
                    workspaceContext: context.workspaceId,
                    ...message.metadata,
                  },
                };

                try {
                  ConversationMessageSchema.parse(messageObj);
                } catch (error) {
                  if (error instanceof z.ZodError) {
                    throw new ValidationError("Invalid conversation message format", error);
                  }
                  throw error;
                }

                conversationStorage.saveMessage(stream_id, messageObj);

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
        };
      },
    });

    this.initialized = true;
  }

  static registerCapability(capability: DaemonCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  static getAllCapabilities(): DaemonCapability[] {
    this.initialize();
    return Array.from(this.capabilities.values());
  }

  static getCapability(id: string): DaemonCapability | undefined {
    this.initialize();
    return this.capabilities.get(id);
  }

  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}
