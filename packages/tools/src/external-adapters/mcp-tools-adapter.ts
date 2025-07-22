/**
 * MCP Tools Adapter for integrating external MCP servers
 * Direct integration with MCPManager - no unnecessary abstraction layers
 */

import { MCPManager } from "@atlas/mcp";
import { type Tool } from "ai";
import { z } from "zod/v4";

export const MCPToolsAdapterConfigSchema = z.object({
  mcpServers: z.array(z.string().min(1)).min(0),
  filters: z.object({
    include: z.array(z.instanceof(RegExp)).optional(),
    exclude: z.array(z.instanceof(RegExp)).optional(),
  }).optional(),
  cache: z.object({
    enabled: z.boolean().default(true),
    ttl: z.number().positive().default(300_000), // 5 minutes
    maxSize: z.number().positive().default(100),
  }).optional().default({
    enabled: true,
    ttl: 300_000,
    maxSize: 100,
  }),
});

export interface ToolCache {
  get(key: string): readonly Tool[] | undefined;
  set(key: string, tools: readonly Tool[], ttl: number): void;
  delete(key: string): boolean;
  clear(): void;
  size(): number;
}

export interface ToolFilter {
  shouldInclude(toolName: string): boolean;
}

export type Result<T, E = Error> = {
  readonly success: true;
  readonly data: T;
} | {
  readonly success: false;
  readonly error: E;
};

/**
 * In-memory LRU cache implementation
 */
class LRUToolCache implements ToolCache {
  private readonly cache = new Map<string, {
    readonly tools: readonly Tool[];
    readonly timestamp: number;
    readonly ttl: number;
  }>();

  constructor(private readonly maxSize: number = 100) {}

  get(key: string): readonly Tool[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.tools;
  }

  set(key: string, tools: readonly Tool[], ttl: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      tools: [...tools], // Create defensive copy
      timestamp: Date.now(),
      ttl,
    });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Regex-based tool filter implementation
 */
class RegexToolFilter implements ToolFilter {
  constructor(
    private readonly includePatterns: readonly RegExp[] = [],
    private readonly excludePatterns: readonly RegExp[] = [],
  ) {}

  shouldInclude(toolName: string): boolean {
    // Check exclusion patterns first (more efficient)
    if (this.excludePatterns.some((pattern) => pattern.test(toolName))) {
      return false;
    }

    // If no include patterns, include by default
    if (this.includePatterns.length === 0) {
      return true;
    }

    // Check inclusion patterns
    return this.includePatterns.some((pattern) => pattern.test(toolName));
  }
}

/**
 * Adapter for fetching and caching tools from MCP servers
 */
export class MCPToolsAdapter {
  private readonly cache: ToolCache;

  constructor(
    private readonly mcpManager: MCPManager,
    cache?: ToolCache,
  ) {
    this.cache = cache ?? new LRUToolCache();
  }

  /**
   * Get tools from MCP servers with type-safe configuration
   */
  async getTools(config: MCPToolsAdapterConfig): Promise<Result<readonly Tool[]>> {
    try {
      // Validate configuration at runtime
      const validConfig = MCPToolsAdapterConfigSchema.parse(config);

      // Check cache first
      if (validConfig.cache.enabled) {
        const cacheKey = this.createCacheKey(validConfig);
        const cachedTools = this.cache.get(cacheKey);
        if (cachedTools) {
          return { success: true, data: cachedTools };
        }
      }

      // Fetch tools directly from MCPManager
      const rawTools = await this.mcpManager.getToolsForServers(validConfig.mcpServers);

      // Apply filtering
      const filter = this.createFilter(validConfig.filters);
      const filteredTools = this.filterTools(rawTools, filter);

      // Cache results
      if (validConfig.cache.enabled) {
        const cacheKey = this.createCacheKey(validConfig);
        this.cache.set(cacheKey, filteredTools, validConfig.cache.ttl);
      }

      return { success: true, data: filteredTools };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: new Error(`Failed to fetch MCP tools: ${errorMessage}`),
      };
    }
  }

  /**
   * Clear all cached tools
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { readonly size: number } {
    return { size: this.cache.size() };
  }

  private createCacheKey(config: z.infer<typeof MCPToolsAdapterConfigSchema>): string {
    const keyData = {
      servers: [...config.mcpServers].sort(), // Sort for consistency
      filters: config.filters
        ? {
          include: config.filters.include?.map((r) => r.source).sort(),
          exclude: config.filters.exclude?.map((r) => r.source).sort(),
        }
        : undefined,
    };

    return JSON.stringify(keyData);
  }

  private createFilter(
    filters: z.infer<typeof MCPToolsAdapterConfigSchema>["filters"],
  ): ToolFilter {
    return new RegexToolFilter(
      filters?.include,
      filters?.exclude,
    );
  }

  private filterTools(
    rawTools: Record<string, Tool>,
    filter: ToolFilter,
  ): readonly Tool[] {
    const result: Tool[] = [];

    for (const [toolName, tool] of Object.entries(rawTools)) {
      if (filter.shouldInclude(toolName)) {
        result.push(tool);
      }
    }

    return Object.freeze(result); // Return immutable array
  }
}

/**
 * Create adapter with default MCP manager
 */
export function createMCPToolsAdapter(mcpManager?: MCPManager): MCPToolsAdapter {
  const manager = mcpManager ?? new MCPManager();
  return new MCPToolsAdapter(manager);
}

/**
 * Convenience function for getting tools (with error handling)
 */
export async function getMCPTools(
  servers: readonly string[],
  options?: Partial<Omit<MCPToolsAdapterConfig, "mcpServers">>,
): Promise<readonly Tool[]> {
  const adapter = createMCPToolsAdapter();

  const config: MCPToolsAdapterConfig = {
    mcpServers: [...servers],
    ...options,
  };

  const result = await adapter.getTools(config);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

/**
 * Configuration for MCP Tools Adapter
 */
export interface MCPToolsAdapterConfig {
  readonly mcpServers: string[];
  readonly filters?: {
    readonly include?: RegExp[];
    readonly exclude?: RegExp[];
  };
  readonly cache?: {
    readonly enabled?: boolean;
    readonly ttl?: number;
    readonly maxSize?: number;
  };
}
