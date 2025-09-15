/**
 * Memory Configuration Manager for Atlas
 *
 * Encapsulates memory behavior and provides configuration-driven memory management
 * for agents, sessions, and workspaces with proper scoping and limits.
 */

import { logger } from "@atlas/logger";
import { CoALAMemoryManager, type CoALAMemoryType } from "@atlas/memory";
import { InMemoryStorageAdapter } from "@atlas/storage";
import type { IAtlasScope } from "../types/core.ts";

interface MemoryLimits {
  relevant_memories: number;
  past_successes: number;
  past_failures: number;
}

interface MemoryTypeConfig {
  enabled: boolean;
  max_age_hours?: number;
  max_age_days?: number;
  max_entries: number;
}

interface MemoryConfiguration {
  enabled: boolean;
  scope: "agent" | "session" | "workspace";
  include_in_context: boolean;
  context_limits: MemoryLimits;
  memory_types: Record<string, MemoryTypeConfig>;
}

interface MemoryRetentionConfig {
  max_age_days: number;
  max_entries: number;
  cleanup_interval_hours: number;
}

interface AtlasMemoryConfig {
  default: {
    enabled: boolean;
    storage: string;
    cognitive_loop: boolean;
    retention: MemoryRetentionConfig;
  };
  streaming?: {
    enabled: boolean;
    queue_max_size: number;
    batch_size: number;
    flush_interval_ms: number;
    background_processing: boolean;
    persistence_enabled: boolean;
    error_retry_attempts: number;
    priority_processing: boolean;
    dual_write_enabled: boolean;
    legacy_batch_enabled: boolean;
    stream_everything: boolean;
    performance_tracking: boolean;
  };
  agent: MemoryConfiguration;
  session: MemoryConfiguration;
  workspace: MemoryConfiguration;
}

export class MemoryConfigManager {
  private config: AtlasMemoryConfig;
  private memoryInstances: Map<string, CoALAMemoryManager> = new Map();

  constructor(config: AtlasMemoryConfig) {
    this.config = config;
  }

  /**
   * Get or create a memory manager for a specific scope
   */
  getMemoryManager(
    scope: IAtlasScope,
    memoryScope: "agent" | "session" | "workspace",
  ): CoALAMemoryManager {
    const scopeConfig = this.config[memoryScope];

    if (!scopeConfig.enabled) {
      // Return a disabled memory manager
      return this.createDisabledMemoryManager(scope);
    }

    // Create unique key based on scope and memory configuration
    const memoryKey = this.generateMemoryKey(scope, memoryScope);

    if (this.memoryInstances.has(memoryKey)) {
      return this.memoryInstances.get(memoryKey)!;
    }

    // Create new memory manager with scope-specific configuration
    const memoryManager = this.createConfiguredMemoryManager(scope, scopeConfig);
    this.memoryInstances.set(memoryKey, memoryManager);

    logger.debug("Created memory manager", {
      memoryKey: memoryKey.slice(0, 16),
      scope: memoryScope,
      enabled: scopeConfig.enabled,
      contextLimits: scopeConfig.context_limits,
    });

    return memoryManager;
  }

  /**
   * Build memory context for LLM calls with configuration-driven limits
   */
  buildMemoryContext(
    memoryManager: CoALAMemoryManager,
    userPrompt: string,
    memoryScope: "agent" | "session" | "workspace",
  ): { systemContext: string; userContext: string } {
    const scopeConfig = this.config[memoryScope];

    if (!scopeConfig.enabled || !scopeConfig.include_in_context) {
      return { systemContext: "", userContext: "" };
    }

    const limits = scopeConfig.context_limits;

    // Get memories with configuration-defined limits
    const relevantMemories = this.getFilteredMemories(
      memoryManager,
      userPrompt,
      limits.relevant_memories,
      scopeConfig,
    );

    const pastSuccesses = this.getFilteredSuccesses(
      memoryManager,
      limits.past_successes,
      scopeConfig,
    );

    const pastFailures = this.getFilteredFailures(memoryManager, limits.past_failures, scopeConfig);

    let systemContext = "";
    const userContext = "";

    // Build context based on available memories
    if (relevantMemories.length > 0) {
      systemContext += `\n--- ${memoryScope.toUpperCase()} Memory Context ---\n`;
      systemContext += "Relevant past experiences:\n";
      relevantMemories.forEach((memory, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(memory.content)}\n`;
      });
    }

    if (pastSuccesses.length > 0) {
      systemContext += "\nPast successful approaches:\n";
      pastSuccesses.forEach((success, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(success.content)}\n`;
      });
    }

    if (pastFailures.length > 0) {
      systemContext += "\nPast failures to avoid:\n";
      pastFailures.forEach((failure, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(failure.content)}\n`;
      });
    }

    return { systemContext, userContext };
  }

  /**
   * Remember information with scope-appropriate configuration
   */
  rememberWithScope(
    memoryManager: CoALAMemoryManager,
    key: string,
    content: unknown,
    memoryType: CoALAMemoryType,
    memoryScope: "agent" | "session" | "workspace",
    tags: string[] = [],
    relevanceScore: number = 0.5,
  ): void {
    const scopeConfig = this.config[memoryScope];

    if (!scopeConfig.enabled) {
      return;
    }

    const typeConfig = scopeConfig.memory_types[memoryType];
    if (!typeConfig?.enabled) {
      return;
    }

    // Apply scope-specific tags
    const scopedTags = [...tags, memoryScope, `scope:${memoryScope}`];

    memoryManager.rememberWithMetadata(key, content, {
      memoryType,
      tags: scopedTags,
      relevanceScore,
      confidence: 1.0,
      decayRate: this.calculateDecayRate(typeConfig),
    });

    // Enforce memory limits
    this.enforceMemoryLimits(memoryManager, memoryType, typeConfig);
  }

  /**
   * Clean up memory instances
   */
  cleanup(): void {
    for (const [key, memoryManager] of this.memoryInstances) {
      try {
        memoryManager.dispose();
      } catch (error) {
        logger.warn("Error disposing memory manager", {
          memoryKey: key.slice(0, 16),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.memoryInstances.clear();
  }

  // Private helper methods

  private generateMemoryKey(
    scope: IAtlasScope,
    memoryScope: "agent" | "session" | "workspace",
  ): string {
    switch (memoryScope) {
      case "agent":
        return `agent:${scope.id}`;
      case "session":
        return `session:${scope.parentScopeId || scope.id}`;
      case "workspace":
        return `workspace:${this.findWorkspaceId(scope)}`;
      default:
        return `unknown:${scope.id}`;
    }
  }

  private findWorkspaceId(scope: IAtlasScope): string {
    // Navigate up the scope hierarchy to find workspace ID
    const currentScope = scope;
    while (currentScope.parentScopeId) {
      // In a real implementation, we'd traverse the scope hierarchy
      // For now, use a simple heuristic
      break;
    }
    return currentScope.id;
  }

  private createConfiguredMemoryManager(
    scope: IAtlasScope,
    _config: MemoryConfiguration,
  ): CoALAMemoryManager {
    // Use InMemoryStorageAdapter in test environments to prevent resource leaks
    const storageAdapter =
      Deno.env.get("DENO_TESTING") === "true" ? new InMemoryStorageAdapter() : undefined; // Use default storage

    // Disable cognitive loop in test environments to prevent resource leaks
    const enableCognitiveLoop =
      Deno.env.get("DENO_TESTING") === "true" ? false : this.config.default.cognitive_loop;

    return new CoALAMemoryManager(scope, storageAdapter, enableCognitiveLoop);
  }

  private createDisabledMemoryManager(scope: IAtlasScope): CoALAMemoryManager {
    // Use InMemoryStorageAdapter in test environments to prevent resource leaks
    const storageAdapter =
      Deno.env.get("DENO_TESTING") === "true" ? new InMemoryStorageAdapter() : undefined;

    return new CoALAMemoryManager(
      scope,
      storageAdapter,
      false, // Disable cognitive loop
    );
  }

  private getFilteredMemories(
    memoryManager: CoALAMemoryManager,
    userPrompt: string,
    limit: number,
    config: MemoryConfiguration,
  ): unknown[] {
    if (
      !config.memory_types.working?.enabled &&
      !config.memory_types.episodic?.enabled &&
      !config.memory_types.semantic?.enabled
    ) {
      return [];
    }

    return memoryManager.queryMemories({ content: userPrompt, minRelevance: 0.3, limit });
  }

  private getFilteredSuccesses(
    memoryManager: CoALAMemoryManager,
    limit: number,
    config: MemoryConfiguration,
  ): unknown[] {
    if (!config.memory_types.procedural?.enabled) {
      return [];
    }

    return memoryManager.queryMemories({ tags: ["success"], minRelevance: 0.5, limit });
  }

  private getFilteredFailures(
    memoryManager: CoALAMemoryManager,
    limit: number,
    config: MemoryConfiguration,
  ): unknown[] {
    if (!config.memory_types.procedural?.enabled) {
      return [];
    }

    return memoryManager.queryMemories({ tags: ["failure"], minRelevance: 0.5, limit });
  }

  private calculateDecayRate(typeConfig: MemoryTypeConfig): number {
    // Calculate decay rate based on max age configuration
    if (typeConfig.max_age_hours) {
      return 0.1 / (typeConfig.max_age_hours / 24); // Faster decay for shorter lifespans
    }
    if (typeConfig.max_age_days) {
      return 0.05 / typeConfig.max_age_days; // Slower decay for longer lifespans
    }
    return 0.05; // Default decay rate
  }

  private enforceMemoryLimits(
    memoryManager: CoALAMemoryManager,
    memoryType: CoALAMemoryType,
    typeConfig: MemoryTypeConfig,
  ): void {
    const memories = memoryManager.getMemoriesByType(memoryType);

    if (memories.length > typeConfig.max_entries) {
      // Remove oldest memories that exceed the limit
      const sortedByAge = memories.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      const toRemove = sortedByAge.slice(0, memories.length - typeConfig.max_entries);
      for (const memory of toRemove) {
        memoryManager.forget(memory.id);
      }

      logger.debug("Enforced memory limits", {
        memoryType,
        removed: toRemove.length,
        remaining: typeConfig.max_entries,
      });
    }
  }
}
