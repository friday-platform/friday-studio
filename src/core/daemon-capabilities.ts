/**
 * Daemon-level capabilities - global capabilities managed by the daemon
 * These are orthogonal to workspaces and handle daemon-level operations
 */

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
    this.daemonInstance = daemon;
  }

  /**
   * Get the daemon instance
   */
  static getDaemonInstance(): any {
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
        stream_id: string,
        message: string,
        metadata?: any,
        conversationId?: string,
      ) => {
        // MCP tool running in worker - make HTTP request to daemon
        const daemonUrl = "http://localhost:8080";

        try {
          console.log(`Making stream request to ${daemonUrl}/api/stream/${stream_id}`);
          const response = await fetch(`${daemonUrl}/api/stream/${stream_id}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message,
              metadata,
              conversationId,
            }),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const result = await response.json();
          console.log("Stream request successful:", result);

          return {
            success: true,
            message: "Reply sent successfully",
            conversationId,
            messageId: result.messageId || crypto.randomUUID(),
            stream_id,
          };
        } catch (error) {
          console.error("Stream API request failed:", error);
          // Stream disconnected or other error
          return {
            success: false,
            error: "stream_send_failed",
            message: error instanceof Error ? error.message : String(error),
            conversationId,
            stream_id,
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

    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`Unknown daemon capability: ${capabilityId}`);
    }

    return await capability.implementation(context, ...args);
  }

  /**
   * Reset registry (useful for testing)
   */
  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}
