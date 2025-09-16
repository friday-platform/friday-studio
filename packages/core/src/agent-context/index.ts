/**
 * Agent Context Builder Factory
 *
 * Creates a function for building complete agent execution contexts,
 * including MCP tools, environment variables, and memory integration.
 */

import type { AgentContext, AgentSessionData, AtlasAgent, AtlasTool } from "@atlas/agent-sdk";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { type CoALAMemoryManager, CoALAMemoryType, MemorySource } from "@atlas/memory";
import { createAtlasClient } from "@atlas/oapi-client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import { stripSourceAttributionTags } from "../prompts/source-attribution.ts";
import { MCPStreamEmitter } from "../streaming/stream-emitters.ts";
import { createEnvironmentContext } from "./environment-context.ts";

interface AgentContextBuilderDeps {
  daemonUrl: string;
  mcpServerPool: GlobalMCPServerPool;
  logger: Logger;
  server?: Server;
  hasActiveSSE?: () => boolean; // Add SSE check
}

/**
 * Create an agent context builder function
 */
export function createAgentContextBuilder(deps: AgentContextBuilderDeps) {
  const { daemonUrl, mcpServerPool, logger } = deps;
  const atlasClient = createAtlasClient({ baseUrl: daemonUrl });

  // Create factory functions
  const validateEnvironment = createEnvironmentContext(logger);

  /**
   * Build full agent execution context and enrich prompt with memories
   */
  return async function buildAgentContext(
    agent: AtlasAgent,
    sessionData: AgentSessionData & { streamId?: string },
    sessionMemory: CoALAMemoryManager | null,
    prompt: string,
    overrides?: Partial<AgentContext>,
    previousResults?: Array<{ agentId: string; task: string; input: unknown; output: unknown }>,
  ): Promise<{ context: AgentContext; enrichedPrompt: string }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    // 1. Fetch all tools directly from MCP servers
    let allTools: Record<string, AtlasTool> = {};
    try {
      allTools = await fetchAllTools(
        sessionData.workspaceId,
        agent.mcpConfig,
        atlasClient,
        mcpServerPool,
        logger,
      );

      agentLogger.info("Pre-fetched tools", { toolCount: Object.keys(allTools).length });
    } catch (error) {
      agentLogger.error("Failed to pre-fetch tools", { error });
      // Continue with empty tools rather than failing entirely
      allTools = {};
    }

    // 2. Build environment context with validated variables
    const envContext = await validateEnvironment(
      sessionData.workspaceId,
      agent.metadata.id,
      agent.environmentConfig,
    );

    // 3. Store previous results as WORKING memory items if available
    if (previousResults && previousResults.length > 0 && sessionMemory) {
      await storePreviousResultsAsWorkingMemory(
        sessionMemory,
        previousResults,
        sessionData.sessionId,
        agentLogger,
      );
    }

    // 4. Retrieve and format memories into the prompt using memory-based approach
    const enrichedPrompt = await enrichPromptWithMemories(
      agent,
      sessionMemory,
      prompt,
      sessionData,
      agentLogger,
    );

    // 5. Create stream emitter based on context
    let streamEmitter = overrides?.stream;
    if (!streamEmitter) {
      if (deps.server && sessionData.streamId) {
        // When we have a streamId and server, always use MCPStreamEmitter
        // The orchestrator handles its own SSE connection
        agentLogger.info("Creating MCPStreamEmitter", { sessionData });
        streamEmitter = new MCPStreamEmitter(
          deps.server,
          agent.metadata.id,
          sessionData.sessionId,
          agentLogger,
        );
      }
    }

    const context: AgentContext = {
      env: envContext,
      session: sessionData,
      stream: streamEmitter,
      logger: logger.child({
        workspaceId: sessionData.workspaceId,
        sessionId: sessionData.sessionId,
        agentId: agent.metadata.id,
        streamId: sessionData.streamId,
      }),
      // Spread overrides to include abortSignal and other overrides
      ...overrides,
      // Tools should be last to ensure they're available unless explicitly overridden
      tools: overrides?.tools || allTools,
    };

    return { context, enrichedPrompt };
  };
}

/**
 * Fetch all tools directly from MCP servers
 * Merges workspace, platform, and agent servers with proper precedence
 */
async function fetchAllTools(
  workspaceId: string,
  agentMCPConfig: Record<string, MCPServerConfig> | undefined,
  atlasClient: ReturnType<typeof createAtlasClient>,
  mcpServerPool: GlobalMCPServerPool,
  logger: Logger,
): Promise<Record<string, AtlasTool>> {
  logger.debug("Fetching tools from MCP servers", {
    workspaceId,
    agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
  });

  // Get workspace config from daemon
  const { data, error } = await atlasClient.GET("/api/workspaces/{workspaceId}/config", {
    params: { path: { workspaceId } },
  });
  if (error) {
    logger.error("Failed to fetch workspace config", {
      operation: "fetch_all_tools",
      workspaceId,
      error,
    });
    throw new Error(`Failed to fetch workspace config: ${error}`);
  }
  const workspaceConfig: WorkspaceConfig = data.config;

  // Merge workspace and agent MCP servers (agent takes precedence)
  const allServerConfigs = mergeServerConfigs(
    workspaceConfig.tools?.mcp?.servers || {},
    agentMCPConfig || {},
    logger,
  );

  logger.info("Created merged MCP server configuration", {
    operation: "fetch_all_tools",
    workspaceId,
    workspaceServers: Object.keys(workspaceConfig.tools?.mcp?.servers ?? {}),
    agentServers: Object.keys(agentMCPConfig || {}),
    totalServerCount: Object.keys(allServerConfigs).length,
    serverIds: Object.keys(allServerConfigs),
  });

  // Get pooled MCP manager and fetch all tools
  const mcpManager = await mcpServerPool.getMCPManager(allServerConfigs);
  const serverIds = Object.keys(allServerConfigs);

  try {
    const tools = await mcpManager.getToolsForServers(serverIds);

    // Release the manager back to the pool
    mcpServerPool.releaseMCPManager(allServerConfigs);

    return tools;
  } catch (error) {
    // Make sure to release the manager even on error
    mcpServerPool.releaseMCPManager(allServerConfigs);
    throw error;
  }
}

/**
 * Merge MCP server configs with precedence: agent > platform > workspace
 */
function mergeServerConfigs(
  workspaceServers: Record<string, MCPServerConfig>,
  agentServers: Record<string, MCPServerConfig>,
  logger: Logger,
): Record<string, MCPServerConfig> {
  // Start with workspace servers (lowest priority)
  const merged = { ...workspaceServers };

  // Add Atlas platform server (takes priority over workspace servers)
  const platformServerConfig: MCPServerConfig = {
    transport: { type: "http", url: "http://localhost:8080/mcp" },
  };

  merged["atlas-platform"] = platformServerConfig;

  // Agent servers take highest precedence over everything
  for (const [id, agentConfig] of Object.entries(agentServers)) {
    if (merged[id]) {
      logger.info("Agent MCP server overriding other server", {
        operation: "merge_server_configs",
        serverId: id,
        existingTransport: merged[id].transport.type,
        agentTransport: agentConfig.transport.type,
      });
    }

    merged[id] = agentConfig;
  }

  return merged;
}

/**
 * Enrich prompt with relevant memories using memory-based approach
 * Implements MECMF memory enhancement with 200k token-aware optimization
 */
async function enrichPromptWithMemories(
  agent: AtlasAgent,
  sessionMemory: CoALAMemoryManager | null,
  originalPrompt: string,
  sessionData: AgentSessionData,
  logger: Logger,
): Promise<string> {
  // Without memory manager, return original prompt
  if (!sessionMemory) {
    return originalPrompt;
  }

  try {
    // Calculate available token budget for memory enhancement (200k limit)
    const maxTokens = calculateAvailableTokenBudget(originalPrompt);

    // Get the most recent WORKING memory item (latest agent output/context)
    const recentWorkingMemory = await getMostRecentWorkingMemory(
      sessionMemory,
      sessionData.sessionId,
      logger,
    );

    // Retrieve relevant memories using vector and text search
    const memoryResults = await sessionMemory.getRelevantMemoriesForPrompt(
      originalPrompt, // Use original prompt for memory search
      {
        limit: 10, // Fewer candidates to reduce context size
        minSimilarity: 0.6, // Higher threshold for tighter relevance
        includeWorking: true,
        includeEpisodic: true,
        includeSemantic: true,
        includeProcedural: true,
      },
    );

    // Compose prompt: Original Request + Recent Context + Relevant Memories
    // Sanitize any prior content to avoid leaking/replicating source tags
    const sanitizedRecent = recentWorkingMemory
      ? {
          content: stripSourceAttributionTags(recentWorkingMemory.content),
          timestamp: recentWorkingMemory.timestamp,
        }
      : null;
    const sanitizedMemories = memoryResults.memories.map((m) => ({
      ...m,
      content: stripSourceAttributionTags(m.content),
    }));

    const enrichedPrompt = buildMemoryEnhancedPrompt(
      originalPrompt,
      sanitizedRecent,
      sanitizedMemories,
      maxTokens,
      logger,
    );

    logger.debug("Prompt enhanced with memories", {
      agentId: agent.metadata.id,
      sessionId: sessionData.sessionId,
      originalLength: originalPrompt.length,
      enhancedLength: enrichedPrompt.length,
      memoriesUsed: memoryResults.memories.length,
      hasRecentContext: !!recentWorkingMemory,
    });

    logger.debug("Prompt passed to agent", { prompt: enrichedPrompt, agentId: agent.metadata.id });

    return enrichedPrompt;
  } catch (error) {
    // Graceful fallback - log error but continue with original prompt
    logger.warn("Failed to enhance prompt with memories, using fallback", {
      error: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      agentId: agent.metadata.id,
      sessionId: sessionData.sessionId,
    });

    return originalPrompt;
  }
}

/**
 * Store previous agent results as WORKING memory items
 * This prevents context growth in long-running sessions
 */
async function storePreviousResultsAsWorkingMemory(
  sessionMemory: CoALAMemoryManager,
  previousResults: Array<{ agentId: string; task: string; input: unknown; output: unknown }>,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    for (const result of previousResults) {
      // Store the actual output as the primary content for the next agent
      const outputStr =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);

      // Create a structured memory content that preserves the actual data
      // The output is the most important part for the next agent in the chain
      // Truncate or summarize the task to avoid storing entire prompts/code
      const taskSummary = result.task
        ? result.task.length > 100
          ? `${result.task.substring(0, 97)}...`
          : result.task
        : "No prompt available";

      const memoryContent = { input: taskSummary, output: outputStr };

      // Store as WORKING memory with session-specific key
      const memoryKey = `wrk:${sessionId}:agent_result:${result.agentId}:${Date.now()}`;

      sessionMemory.rememberWithMetadata(memoryKey, memoryContent, {
        memoryType: CoALAMemoryType.WORKING,
        tags: ["working", "session", "agent_result", result.agentId],
        relevanceScore: 0.9, // High relevance for recent outputs
        source: MemorySource.AGENT_OUTPUT,
        sourceMetadata: { agentId: result.agentId, sessionId },
      });
    }

    logger.debug("Stored previous results as WORKING memory", {
      sessionId,
      resultCount: previousResults.length,
    });
  } catch (error) {
    logger.warn("Failed to store previous results as WORKING memory", {
      error: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      },
      sessionId,
    });
  }
}

/**
 * Get the most recent WORKING memory item for context continuity
 */
async function getMostRecentWorkingMemory(
  sessionMemory: CoALAMemoryManager,
  sessionId: string,
  logger: Logger,
): Promise<{ content: string; timestamp: Date } | null> {
  try {
    const workingMemories = await sessionMemory.getRelevantMemoriesForPrompt(
      "", // Empty query to get all working memories
      {
        includeWorking: true,
        includeEpisodic: false,
        includeSemantic: false,
        includeProcedural: false,
        limit: 1, // Only get the most recent
        tags: ["agent_result"], // Focus on agent results (input+output)
      },
    );

    if (workingMemories.memories.length > 0) {
      const recent = workingMemories.memories[0];
      if (recent) {
        return { content: recent.content, timestamp: recent.timestamp || new Date() };
      }
    }

    return null;
  } catch (error) {
    logger.error("Failed to retrieve recent working memory", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null; // Fallback to null on error
  }
}

/**
 * Calculate available token budget for memory enhancement
 * Updated for 200k token context window limit
 */
function calculateAvailableTokenBudget(prompt: string): number {
  // Rough token estimation: 1 token ≈ 4 characters for English text
  const promptTokens = Math.ceil(prompt.length / 4);

  // 200k token context window with proper reserves
  const maxContextTokens = 200000;
  const reservedResponseTokens = 8000; // Larger response buffer for 200k model
  const bufferTokens = Math.ceil(maxContextTokens * 0.05); // 5% buffer for 200k

  const availableForMemory =
    maxContextTokens - promptTokens - reservedResponseTokens - bufferTokens;

  // Ensure minimum viable budget (much higher for 200k model)
  return Math.max(availableForMemory, 5000);
}

/**
 * Build memory-enhanced prompt: Original Request + Recent Context + Relevant Memories
 * Optimized for 200k token context with intelligent allocation
 */
function buildMemoryEnhancedPrompt(
  originalPrompt: string,
  recentWorkingMemory: { content: string; timestamp: Date } | null,
  allMemories: Array<{
    memoryType: string;
    content: string;
    relevanceScore?: number;
    similarity?: number;
    timestamp?: Date;
  }>,
  maxTokens: number,
  logger: Logger,
): string {
  const sections: string[] = [];
  let tokensUsed = Math.ceil(originalPrompt.length / 4); // Start with original prompt tokens

  // Reserve tokens for original request (always included)
  const originalRequestSection = originalPrompt;

  // 1. Add most recent working memory for immediate context (high priority)
  if (recentWorkingMemory && tokensUsed < maxTokens * 0.7) {
    // Use up to 70% for recent context
    const recentTokens = Math.ceil(recentWorkingMemory.content.length / 4);
    if (tokensUsed + recentTokens <= maxTokens * 0.3) {
      // Max 30% for recent context
      sections.push(`## Previous Agent Output\n${recentWorkingMemory.content}`);
      tokensUsed += recentTokens;
    }
  }

  // 2. Allocate remaining tokens to memory types with smart prioritization
  const remainingTokens = maxTokens - tokensUsed - Math.ceil(originalRequestSection.length / 4);

  if (remainingTokens > 1000 && allMemories.length > 0) {
    const memoryAllocation = allocateMemoriesWithSmartPrioritization(
      allMemories,
      remainingTokens,
      recentWorkingMemory !== null, // Adjust allocation if we have recent context
    );

    // Add memory sections in order of importance
    if (memoryAllocation.procedural.length > 0) {
      const proceduralContext = memoryAllocation.procedural.map((m) => m.content).join("\n");
      sections.push(`## Relevant Procedures and Guidelines\n${proceduralContext}`);
    }

    if (memoryAllocation.semantic.length > 0) {
      const semanticContext = memoryAllocation.semantic.map((m) => m.content).join("\n");
      sections.push(`## Relevant Knowledge and Facts\n${semanticContext}`);
    }

    if (memoryAllocation.working.length > 0) {
      const workingContext = memoryAllocation.working.map((m) => m.content).join("\n");
      sections.push(`## Additional Session Context\n${workingContext}`);
    }

    if (memoryAllocation.episodic.length > 0) {
      const episodicContext = memoryAllocation.episodic.map((m) => m.content).join("\n");
      sections.push(`## Past Experiences and Outcomes\n${episodicContext}`);
    }

    logger.debug("Memory allocation in prompt", {
      totalMemories: allMemories.length,
      proceduralCount: memoryAllocation.procedural.length,
      semanticCount: memoryAllocation.semantic.length,
      workingCount: memoryAllocation.working.length,
      episodicCount: memoryAllocation.episodic.length,
      tokensUsed: memoryAllocation.totalTokensUsed,
      remainingTokens,
    });
  }

  // 3. Compose final prompt: Memory Sections + Original Request
  if (sections.length > 0) {
    return `${sections.join("\n\n")}\n\n${originalRequestSection}`;
  }

  return originalRequestSection;
}

/**
 * Smart memory allocation that adjusts based on context availability
 */
function allocateMemoriesWithSmartPrioritization(
  memories: Array<{
    memoryType: string;
    content: string;
    relevanceScore?: number;
    similarity?: number;
    timestamp?: Date;
  }>,
  totalTokenBudget: number,
  hasRecentContext: boolean,
): MemoryAllocation {
  // Group memories by type
  const memoriesByType = memories.reduce((acc, memory) => {
    const type = memory.memoryType;
    if (!acc[type]) acc[type] = [];
    acc[type].push(memory);
    return acc;
  }, {});

  // Sort each type by relevance (similarity or relevanceScore)
  Object.values(memoriesByType).forEach((typeMemories) => {
    typeMemories.sort((a, b) => {
      const aScore = a.similarity || a.relevanceScore || 0;
      const bScore = b.similarity || b.relevanceScore || 0;
      return bScore - aScore;
    });
  });

  const allocation: MemoryAllocation = {
    working: [],
    procedural: [],
    semantic: [],
    episodic: [],
    totalTokensUsed: 0,
  };

  // Adjust allocation based on whether we have recent context
  const typeAllocations = hasRecentContext
    ? {
        // Reduce working memory allocation since we have recent context
        WORKING: Math.ceil(totalTokenBudget * 0.2), // Reduced from 40%
        PROCEDURAL: Math.ceil(totalTokenBudget * 0.35), // Increased for procedures
        SEMANTIC: Math.ceil(totalTokenBudget * 0.35), // Increased for knowledge
        EPISODIC: Math.ceil(totalTokenBudget * 0.1),
      }
    : {
        // Standard MECMF allocation when no recent context
        WORKING: Math.ceil(totalTokenBudget * 0.4),
        PROCEDURAL: Math.ceil(totalTokenBudget * 0.25),
        SEMANTIC: Math.ceil(totalTokenBudget * 0.25),
        EPISODIC: Math.ceil(totalTokenBudget * 0.1),
      };

  // Allocate memories within token budget for each type
  for (const [type, budget] of Object.entries(typeAllocations)) {
    const typeMemories = memoriesByType[type] || [];
    let usedTokens = 0;

    for (const memory of typeMemories) {
      const memoryTokens = Math.ceil(memory.content.length / 4);
      if (usedTokens + memoryTokens <= budget) {
        const targetArray =
          type === "WORKING"
            ? allocation.working
            : type === "PROCEDURAL"
              ? allocation.procedural
              : type === "SEMANTIC"
                ? allocation.semantic
                : allocation.episodic;

        targetArray.push(memory);
        usedTokens += memoryTokens;
        allocation.totalTokensUsed += memoryTokens;
      }
    }
  }

  return allocation;
}

/**
 * Memory allocation result interface
 */
interface MemoryAllocation {
  working: Array<{ content: string; relevanceScore?: number; similarity?: number }>;
  procedural: Array<{ content: string; relevanceScore?: number; similarity?: number }>;
  semantic: Array<{ content: string; relevanceScore?: number; similarity?: number }>;
  episodic: Array<{ content: string; relevanceScore?: number; similarity?: number }>;
  totalTokensUsed: number;
}
// Re-export types for convenience;
