/**
 * Workspace Memory Tool - Access to session bridge and worklog memory
 *
 * Provides conversation agents with access to workspace memory for context continuity
 */

import { logger } from "@atlas/logger";
import { type CoALAMemoryEntry, CoALAMemoryManager } from "@atlas/memory";
import { tool } from "ai";
import { z } from "zod";

// Helper to safely extract error message from unknown error
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const workspaceMemoryTool = tool({
  description:
    "Access workspace memory for conversation context including session bridge memories and recent worklog entries.",
  inputSchema: z.object({
    operation: z
      .enum(["load_context", "get_bridge_memories", "get_worklog"])
      .describe("The memory operation to perform"),
    maxEntries: z
      .number()
      .int()
      .positive()
      .optional()
      .default(10)
      .describe("Maximum number of memory entries to retrieve"),
    sessionId: z.string().optional().describe("Session ID for context (optional)"),
    prompt: z.string().optional().describe("Prompt for context (optional)"),
  }),
  execute: async ({ operation, maxEntries, sessionId, prompt }) => {
    try {
      // Access the workspace memory through Atlas's memory storage
      // Use dynamic workspace detection from context (session data should contain workspace info)
      const scope = {
        id: sessionId || "conversation-context",
        workspaceId: "atlas-conversation", // Default for system conversation workspace
      };

      // Initialize CoALA memory manager with proper constructor signature
      const memoryManager = new CoALAMemoryManager(
        scope,
        undefined, // Use default storage adapter which will use workspace memory dir
        false, // Disable cognitive loop for read-only access
      );

      switch (operation) {
        case "load_context": {
          // Ensure memories are loaded from storage before querying
          await memoryManager.ensureLoaded();

          let allMemories: CoALAMemoryEntry[] = [];

          try {
            // First try enhanced search with vector search
            const memoryResults = await memoryManager.getRelevantMemoriesForPrompt(
              prompt || "atlas conversation workspace agent", // Query for workspace and agent context
              {
                includeWorking: true, // Skip working memory for context loading
                includeEpisodic: true, // Include past conversations
                includeSemantic: true, // Include facts and knowledge
                includeProcedural: true, // Include workflows and patterns
                limit: maxEntries * 2, // Get more candidates to filter
                minSimilarity: 0.7, // Lower threshold to catch more relevant context
                tags: undefined, // Don't filter by tags to get all relevant memories
              },
            );
            allMemories = memoryResults.memories;
          } catch (vectorSearchError) {
            logger.debug("Vector search failed, falling back to traditional queries:", {
              error: vectorSearchError,
            });
          }

          // If vector search failed or returned no results, fallback to traditional memory queries
          if (allMemories.length === 0) {
            logger.debug("Using fallback memory queries");

            // Query each memory type separately
            const episodicMemories = memoryManager.queryMemories({
              memoryType: "episodic",
              limit: maxEntries,
              sourceScope: "atlas-conversation",
            });

            const semanticMemories = memoryManager.queryMemories({
              memoryType: "semantic",
              limit: maxEntries,
              sourceScope: "atlas-conversation",
            });

            const proceduralMemories = memoryManager.queryMemories({
              memoryType: "procedural",
              limit: maxEntries,
              sourceScope: "atlas-conversation",
            });

            // Combine all memories
            allMemories = [
              ...episodicMemories.map((m) => ({ ...m })),
              ...semanticMemories.map((m) => ({ ...m })),
              ...proceduralMemories.map((m) => ({ ...m })),
            ];

            logger.debug("Fallback found memories:", {
              episodic: episodicMemories.length,
              semantic: semanticMemories.length,
              procedural: proceduralMemories.length,
              total: allMemories.length,
            });
          }

          logger.debug("Retrieved memories count:", { count: allMemories.length });
          logger.debug("First memory structure:", {
            memory: allMemories[0] ? JSON.stringify(allMemories[0], null, 2) : "No memories",
          });

          // Separate memories by type for different processing
          const episodicMemories = allMemories.filter((m) => m.memoryType === "episodic");
          const semanticMemories = allMemories.filter((m) => m.memoryType === "semantic");
          const proceduralMemories = allMemories.filter((m) => m.memoryType === "procedural");

          // Format episodic memories as conversation context
          const conversationHistory = episodicMemories
            .filter((m) => {
              const hasAgentExecution =
                m.content &&
                typeof m.content === "object" &&
                m.content.eventType === "agent_execution";
              logger.debug("Memory filter result:", { hasAgentExecution, memoryId: m.id });
              logger.debug("Memory content structure:", {
                content: JSON.stringify(m.content, null, 2),
              });
              return hasAgentExecution;
            })
            .map((m) => {
              const content = m.content;
              logger.debug("Processing agent execution:", { content });
              return { user: content || "", assistant: content || "", timestamp: m.timestamp };
            })
            .slice(0, maxEntries);

          logger.debug("Final conversation history:", { count: conversationHistory.length });

          return {
            success: true,
            operation,
            contextEntries: conversationHistory.length,
            conversationHistory,
            memories: allMemories.slice(0, 5), // Include raw memories for debugging
            debug: {
              totalMemories: allMemories.length,
              episodicCount: episodicMemories.length,
              semanticCount: semanticMemories.length,
              proceduralCount: proceduralMemories.length,
              filteredAgentExecutions: conversationHistory.length,
            },
          };
        }

        case "get_bridge_memories": {
          // Get session bridge memories
          const bridgeMemories = memoryManager.queryMemories({
            memoryType: "contextual", // Session bridge memories are stored as contextual
            limit: maxEntries,
            sourceScope: "atlas-conversation",
            tags: ["conversation", "agent_execution"],
          });

          return {
            success: true,
            operation,
            memoriesCount: bridgeMemories.length,
            memories: bridgeMemories.slice(0, maxEntries),
          };
        }

        case "get_worklog": {
          // Get recent worklog entries
          const worklogMemories = memoryManager.queryMemories({
            memoryType: "episodic",
            limit: maxEntries,
            sourceScope: "atlas-conversation",
            tags: ["worklog", "task_completed"],
          });

          return {
            success: true,
            operation,
            worklogCount: worklogMemories.length,
            worklog: worklogMemories,
          };
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    } catch (error) {
      return { success: false, operation, error: getErrorMessage(error) };
    }
  },
});
