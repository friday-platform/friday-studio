/**
 * System Agent Registry
 * Discovers and manages system agents from packages/system/agents/
 */

import { join } from "@std/path";
import { exists } from "@std/fs";
import { BaseAgent } from "./agents/base-agent-v2.ts";
import { AtlasLogger } from "../utils/logger.ts";

export interface SystemAgentMetadata {
  id: string;
  name: string;
  type: "system";
  version: string;
  provider: string;
  description: string;
  capabilities: string[];
  configSchema?: Record<string, unknown>;
}

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

    // Discover agents from packages/system/agents/
    await this.discoverAgents();

    // Store agent metadata in KV
    await this.storeAgentMetadata();

    this.logger.info("System agent registry initialized", {
      agentCount: this.agents.size,
      agentIds: Array.from(this.agents.keys()),
    });
  }

  /**
   * Discover agents from packages/system/agents/ directory
   */
  private static async discoverAgents(): Promise<void> {
    const agentsDir = join(Deno.cwd(), "packages", "system", "agents");

    try {
      if (!(await exists(agentsDir))) {
        this.logger.warn("System agents directory not found", { agentsDir });
        return;
      }

      // Read directory contents
      for await (const entry of Deno.readDir(agentsDir)) {
        if (entry.isFile && entry.name.endsWith(".ts")) {
          await this.loadAgent(agentsDir, entry.name);
        }
      }
    } catch (error) {
      this.logger.error("Failed to discover system agents", { error: error.message, agentsDir });
    }
  }

  /**
   * Load a single agent file
   */
  private static async loadAgent(agentsDir: string, filename: string): Promise<void> {
    try {
      const agentPath = join(agentsDir, filename);
      const agentModule = await import(`file://${agentPath}`);

      // Look for agent classes in the module
      for (const exportName of Object.keys(agentModule)) {
        const agentClass = agentModule[exportName];

        // Check if it's a valid agent class
        if (
          typeof agentClass === "function" &&
          agentClass.prototype instanceof BaseAgent &&
          typeof agentClass.getMetadata === "function"
        ) {
          const metadata = agentClass.getMetadata();

          if (metadata.type === "system") {
            this.agents.set(metadata.id, agentClass);
            this.logger.info("Discovered system agent", {
              id: metadata.id,
              name: metadata.name,
              version: metadata.version,
              file: filename,
            });
          }
        }
      }
    } catch (error) {
      this.logger.error("Failed to load agent", { filename, error: error.message });
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
      this.logger.error("Failed to store agent metadata", { error: error.message });
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
      return (result.value as SystemAgentMetadata) || null;
    } catch (error) {
      this.logger.error("Failed to get agent metadata from KV", { agentId, error: error.message });
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
      return (result.value as string[]) || [];
    } catch (error) {
      this.logger.error("Failed to get agent IDs from KV", { error: error.message });
      return [];
    }
  }
}
