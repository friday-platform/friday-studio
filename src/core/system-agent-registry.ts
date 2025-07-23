/**
 * System Agent Registry
 * Discovers and manages system agents from packages/system/agents/
 */

import { BaseAgent } from "./agents/base-agent-v2.ts";
import { AtlasLogger } from "../utils/logger.ts";
import { z } from "zod/v4";

// Static imports for system agents - embedded at compile time
import { ConversationAgent } from "../../packages/system/agents/conversation-agent.ts";
import { FactExtractor } from "../../packages/system/agents/fact-extractor.ts";

// Zod schema for agent ID validation
const AgentIdSchema = z.string().regex(
  /^[a-zA-Z0-9_-]+$/,
  "Agent ID must contain only letters, numbers, underscores, and hyphens",
);

// Zod schema for SystemAgentMetadata
export const SystemAgentMetadataSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  type: z.literal("system"),
  version: z.string(),
  provider: z.string(),
  description: z.string(),
  capabilities: z.array(z.string()),
  configSchema: z.record(z.string(), z.unknown()).optional(),
});

// Export the inferred type
export type SystemAgentMetadata = z.infer<typeof SystemAgentMetadataSchema>;

export interface SystemAgentConstructor {
  new (config?: Record<string, unknown>, id?: string): BaseAgent;
  getMetadata(): SystemAgentMetadata;
  validateConfig?(config: Record<string, unknown>): { valid: boolean; errors: string[] };
}

export class SystemAgentRegistry {
  private static agents: Map<string, SystemAgentConstructor> = new Map();
  private static kvStorage: {
    get: (key: unknown[]) => Promise<{ value: unknown }>;
    set: (key: unknown[], value: unknown) => Promise<void>;
  } | null = null;
  private static logger = AtlasLogger.getInstance();

  /**
   * Initialize the registry with KV storage and discover agents
   */
  static async initialize(
    kvStorage: {
      get: (key: unknown[]) => Promise<{ value: unknown }>;
      set: (key: unknown[], value: unknown) => Promise<void>;
    },
  ): Promise<void> {
    this.kvStorage = kvStorage;
    this.logger.info("Initializing system agent registry...");

    // Register system agents - embedded at compile time
    this.discoverAgents();

    // Store agent metadata in KV
    await this.storeAgentMetadata();

    this.logger.info("System agent registry initialized", {
      agentCount: this.agents.size,
      agentIds: Array.from(this.agents.keys()),
    });
  }

  /**
   * Register system agents statically - works in compiled binaries
   */
  private static discoverAgents(): void {
    try {
      // Register all system agents - these are embedded at compile time
      const systemAgents: SystemAgentConstructor[] = [
        ConversationAgent,
        FactExtractor,
      ];

      for (const agentClass of systemAgents) {
        // Validate it's a proper agent class
        if (
          typeof agentClass === "function" &&
          agentClass.prototype instanceof BaseAgent &&
          typeof agentClass.getMetadata === "function"
        ) {
          const metadata = agentClass.getMetadata();

          if (metadata.type === "system") {
            this.agents.set(metadata.id, agentClass);
            this.logger.info("Registered system agent", {
              id: metadata.id,
              name: metadata.name,
              version: metadata.version,
            });
          }
        }
      }
    } catch (error) {
      this.logger.error("Failed to register system agents", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Store agent metadata in KV storage
   */
  private static async storeAgentMetadata(): Promise<void> {
    if (!this.kvStorage) return;

    try {
      for (const [agentId, agentClass] of this.agents) {
        const metadata = agentClass.getMetadata();
        const key = ["system-agents", agentId];
        await this.kvStorage.set(key, metadata);
      }

      // Store the list of agent IDs for quick lookup
      const agentIds = Array.from(this.agents.keys());
      await this.kvStorage.set(["system-agents", "_index"], agentIds);

      this.logger.info("Stored system agent metadata in KV", { agentCount: agentIds.length });
    } catch (error) {
      this.logger.error("Failed to store agent metadata", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get all registered system agents
   */
  static listAgents(): SystemAgentMetadata[] {
    return Array.from(this.agents.values()).map((agentClass) => agentClass.getMetadata());
  }

  /**
   * Check if a system agent exists
   */
  static hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get system agent metadata
   */
  static getAgentMetadata(agentId: string): SystemAgentMetadata | null {
    const agentClass = this.agents.get(agentId);
    return agentClass ? agentClass.getMetadata() : null;
  }

  /**
   * Create a system agent instance
   */
  static createAgent(
    agentId: string,
    config: Record<string, unknown> = {},
    instanceId?: string,
  ): BaseAgent {
    const agentClass = this.agents.get(agentId);
    if (!agentClass) {
      throw new Error(`System agent '${agentId}' not found in registry`);
    }

    return new agentClass(config, instanceId);
  }

  /**
   * Validate system agent configuration
   */
  static validateAgentConfig(
    agentId: string,
    config: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const agentClass = this.agents.get(agentId);
    if (!agentClass) {
      return { valid: false, errors: [`System agent '${agentId}' not found`] };
    }

    // Use agent-specific validation if available
    if (typeof agentClass.validateConfig === "function") {
      return agentClass.validateConfig(config);
    }

    // Generic validation - ensure config is an object
    if (typeof config !== "object" || config === null) {
      return { valid: false, errors: ["config must be an object"] };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Get system agent metadata from KV storage (for external consumers)
   */
  static async getAgentMetadataFromKV(agentId: string): Promise<SystemAgentMetadata | null> {
    if (!this.kvStorage) return null;

    try {
      const key = ["system-agents", agentId];
      const result = await this.kvStorage.get(key);

      if (!result.value) return null;

      // Validate the metadata with Zod
      const parseResult = SystemAgentMetadataSchema.safeParse(result.value);
      return parseResult.success ? parseResult.data : null;
    } catch (error) {
      this.logger.error("Failed to get agent metadata from KV", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get all system agent IDs from KV storage
   */
  static async getSystemAgentIds(): Promise<string[]> {
    if (!this.kvStorage) return [];

    try {
      const key = ["system-agents", "_index"];
      const result = await this.kvStorage.get(key);

      if (!result.value) return [];

      // Validate the agent IDs array with Zod
      const AgentIdsSchema = z.array(AgentIdSchema);
      const parseResult = AgentIdsSchema.safeParse(result.value);
      return parseResult.success ? parseResult.data : [];
    } catch (error) {
      this.logger.error("Failed to get agent IDs from KV", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
