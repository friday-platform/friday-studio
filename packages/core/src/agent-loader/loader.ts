import type { AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { convertYAMLAgentToSDK, parseYAMLAgentContent } from "../agent-conversion/index.ts";
import type { AgentAdapter, AgentSourceData, AgentSummary } from "./adapters/types.ts";
import { AgentNotFoundError } from "./errors.ts";

/** Options for configuring the agent loader */
export interface LoaderOptions {
  /** Environment variables for YAML interpolation */
  env?: Record<string, string>;
  /** Whether to validate that required env vars are present */
  validateEnv?: boolean;
  /** Whether to cache loaded agents (default: true) */
  enableCache?: boolean;
  /** Maximum number of agents to keep in cache (default: 100) */
  maxCacheSize?: number;
}

/** Cache entry for loaded agents */
interface CacheEntry {
  agent: AtlasAgent;
  loadedAt: number;
  sourceType: string;
}

/**
 * Coordinates multiple adapters to load agents from different sources.
 * The core of Atlas agent loading system with caching and error handling.
 */
export class AgentLoader {
  private adapters: AgentAdapter[] = [];
  private agentCache = new Map<string, CacheEntry>();
  private logger = createLogger({ component: "AgentLoader" });

  constructor(private options: LoaderOptions = {}) {
    this.options.enableCache = this.options.enableCache ?? true;
    this.options.maxCacheSize = this.options.maxCacheSize ?? 100;
    this.options.validateEnv = this.options.validateEnv ?? true;
  }

  /** Register an adapter for loading agents from a specific source */
  addAdapter(adapter: AgentAdapter): void {
    this.adapters.push(adapter);
    this.logger.debug("Added adapter", { adapterName: adapter.adapterName });
  }

  /** Remove a specific adapter by name */
  removeAdapter(adapterName: string): boolean {
    const index = this.adapters.findIndex((a) => a.adapterName === adapterName);
    if (index >= 0) {
      this.adapters.splice(index, 1);
      this.logger.debug("Removed adapter", { adapterName });
      return true;
    }
    return false;
  }

  /** Get all registered adapters */
  getAdapters(): AgentAdapter[] {
    return [...this.adapters];
  }

  /**
   * Load an agent by ID, trying each adapter until one succeeds.
   * Results are cached for performance.
   */
  async loadAgent(id: string): Promise<AtlasAgent> {
    if (this.options.enableCache && this.agentCache.has(id)) {
      const cached = this.agentCache.get(id)!;
      this.logger.debug("Returning cached agent", { id, sourceType: cached.sourceType });
      return cached.agent;
    }

    const errors: Error[] = [];
    for (const adapter of this.adapters) {
      try {
        this.logger.debug("Trying to load agent with adapter", {
          id,
          adapterName: adapter.adapterName,
        });
        const source = await adapter.loadAgent(id);
        const agent = this.convertToSDKAgent(source);

        if (this.options.enableCache) {
          this.cacheAgent(id, agent, adapter.sourceType);
        }

        this.logger.debug("Successfully loaded agent from adapter", {
          id,
          adapterName: adapter.adapterName,
        });
        return agent;
      } catch (error) {
        // Only log as error if it's not a "not found" error
        if (error instanceof AgentNotFoundError) {
          this.logger.debug("Agent not found in adapter", {
            id,
            adapterName: adapter.adapterName,
            message: error.message,
          });
        } else {
          this.logger.error("Failed to load agent with adapter", {
            id,
            adapterName: adapter.adapterName,
            error,
            agentId: id,
          });
        }
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const errorDetails = errors.map((e) => `  - ${e.message}`).join("\n");
    throw new Error(`Agent not found: ${id}\nTried adapters:\n${errorDetails}`);
  }

  /** List all available agents from all registered adapters */
  async listAgents(): Promise<AgentSummary[]> {
    const allAgents: AgentSummary[] = [];
    const seen = new Set<string>();

    for (const adapter of this.adapters) {
      try {
        const agents = await adapter.listAgents();

        for (const agent of agents) {
          if (!seen.has(agent.id)) {
            seen.add(agent.id);
            allAgents.push(agent);
          } else {
            this.logger.debug("Skipping duplicate agent from adapter", {
              agentId: agent.id,
              adapterName: adapter.adapterName,
            });
          }
        }
      } catch (error) {
        this.logger.warn("Failed to list agents from adapter", {
          adapterName: adapter.adapterName,
          error,
        });
      }
    }

    return allAgents;
  }

  /** Check if an agent exists without loading it */
  async exists(id: string): Promise<boolean> {
    if (this.options.enableCache && this.agentCache.has(id)) {
      return true;
    }

    for (const adapter of this.adapters) {
      try {
        if (await adapter.exists(id)) {
          return true;
        }
      } catch (error) {
        this.logger.debug("Error checking existence with adapter", {
          adapterName: adapter.adapterName,
          error,
        });
      }
    }

    return false;
  }

  /** Clear the agent cache */
  clearCache(): void {
    const size = this.agentCache.size;
    this.agentCache.clear();
    this.logger.debug("Cleared agent cache", { entries: size });
  }

  /** Get cache statistics */
  getCacheStats(): { size: number; maxSize: number; enabled: boolean } {
    return {
      size: this.agentCache.size,
      maxSize: this.options.maxCacheSize!,
      enabled: this.options.enableCache!,
    };
  }

  /** Convert agent source data to an AtlasAgent instance */
  private convertToSDKAgent(source: AgentSourceData): AtlasAgent {
    switch (source.type) {
      case "sdk":
      case "system":
      case "bundled":
        if (!source.agent) {
          throw new Error(`Agent source ${source.type} missing agent instance`);
        }
        return source.agent;

      case "yaml": {
        if (!source.content) {
          throw new Error("YAML agent source missing content");
        }
        const yamlDef = parseYAMLAgentContent(source.content, {
          env: this.options.env,
          validateEnv: this.options.validateEnv,
        });
        return convertYAMLAgentToSDK(yamlDef);
      }

      default:
        throw new Error(`Unknown agent source type: ${source.type}`);
    }
  }

  /** Cache an agent with LRU eviction */
  private cacheAgent(id: string, agent: AtlasAgent, sourceType: string): void {
    if (this.agentCache.size >= this.options.maxCacheSize!) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;

      for (const [cachedId, entry] of this.agentCache.entries()) {
        if (entry.loadedAt < oldestTime) {
          oldestTime = entry.loadedAt;
          oldestId = cachedId;
        }
      }

      if (oldestId) {
        this.agentCache.delete(oldestId);
        this.logger.debug("Evicted oldest cached agent", { agentId: oldestId });
      }
    }

    this.agentCache.set(id, { agent, loadedAt: Date.now(), sourceType });
  }
}
