import { logger } from "@atlas/logger";
import type {
  EnhancedPrompt,
  ExtendedTokenAllocation,
  MemoryEntry,
  MemoryType,
  WorklogEntry,
} from "./mecmf-interfaces.ts";

/**
 * Enhanced Token Budget Manager that includes session bridge and worklog allocations
 * for the Session Bridge + Worklog implementation.
 */
export class EnhancedTokenBudgetManager {
  /**
   * Estimates token count for given text (simple approximation).
   */
  estimateTokens(text: string): number {
    // Simple approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
  // Updated token allocation percentages to include session bridge and worklog
  private readonly EXTENDED_ALLOCATION: ExtendedTokenAllocation = {
    working_memory: 0.35, // 35% (reduced from 40%)
    session_bridge: 0.1, // 10% (new allocation)
    procedural_memory: 0.25, // 25% (unchanged)
    semantic_memory: 0.2, // 20% (reduced from 25%)
    episodic_memory: 0.1, // 10% (unchanged)
    worklog_context: 0.05, // 5% (subset of episodic, for recent worklog)
  };

  /**
   * Allocates tokens with enhanced support for session bridge and worklog content.
   */
  allocateExtendedTokens(budget: number): ExtendedTokenAllocation {
    return {
      working_memory: Math.floor(budget * this.EXTENDED_ALLOCATION.working_memory),
      session_bridge: Math.floor(budget * this.EXTENDED_ALLOCATION.session_bridge),
      procedural_memory: Math.floor(budget * this.EXTENDED_ALLOCATION.procedural_memory),
      semantic_memory: Math.floor(budget * this.EXTENDED_ALLOCATION.semantic_memory),
      episodic_memory: Math.floor(budget * this.EXTENDED_ALLOCATION.episodic_memory),
      worklog_context: Math.floor(budget * this.EXTENDED_ALLOCATION.worklog_context),
    };
  }

  /**
   * Calculates optimal token allocation for session bridge memories.
   */
  calculateSessionBridgeTokens(totalBudget: number, conversationComplexity?: number): number {
    const baseAllocation = Math.floor(totalBudget * this.EXTENDED_ALLOCATION.session_bridge);

    // Adjust based on conversation complexity if provided
    if (conversationComplexity !== undefined) {
      // Higher complexity = more bridge tokens (up to 15% max)
      const complexityMultiplier = 1 + conversationComplexity * 0.5;
      const adjustedAllocation = Math.floor(baseAllocation * complexityMultiplier);
      return Math.min(adjustedAllocation, Math.floor(totalBudget * 0.15));
    }

    return baseAllocation;
  }

  /**
   * Optimizes bridge content selection within token budget.
   */
  optimizeBridgeContent(bridgeMemories: MemoryEntry[], tokenBudget: number): MemoryEntry[] {
    if (bridgeMemories.length === 0 || tokenBudget <= 0) {
      return [];
    }

    // Sort by relevance and recency (with decay factor)
    const scoredBridge = bridgeMemories
      .map((memory) => ({ memory, score: this.calculateBridgeScore(memory) }))
      .sort((a, b) => b.score - a.score);

    const optimized: MemoryEntry[] = [];
    let tokensUsed = 0;

    for (const { memory } of scoredBridge) {
      const memoryTokens = this.estimateMemoryTokens(memory);

      if (tokensUsed + memoryTokens <= tokenBudget) {
        optimized.push(memory);
        tokensUsed += memoryTokens;
      } else if (tokensUsed < tokenBudget) {
        // Try to include compressed version
        const remainingBudget = tokenBudget - tokensUsed;
        if (remainingBudget > 50) {
          // Only compress if significant budget remains
          const compressed = this.compressMemoryContent(memory, remainingBudget);
          if (compressed) {
            optimized.push(compressed);
            break;
          }
        }
      }
    }

    return optimized;
  }

  /**
   * Calculates score for bridge memory prioritization (relevance + recency decay).
   */
  private calculateBridgeScore(memory: MemoryEntry): number {
    const baseScore = memory.relevanceScore;

    // Apply time decay for bridge memories
    const now = new Date();
    const ageHours = (now.getTime() - memory.timestamp.getTime()) / (1000 * 60 * 60);
    const maxAgeHours = 48; // Bridge retention period

    const decayFactor = Math.max(0.3, (maxAgeHours - ageHours) / maxAgeHours);
    return baseScore * decayFactor;
  }

  /**
   * Optimizes worklog entries for token budget.
   */
  optimizeWorklogContent(worklogEntries: WorklogEntry[], tokenBudget: number): WorklogEntry[] {
    if (worklogEntries.length === 0 || tokenBudget <= 0) {
      return [];
    }

    // Sort by relevance (confidence) and recency
    const sortedWorklog = [...worklogEntries].sort((a, b) => {
      // Primary: confidence score
      const confidenceDiff = b.confidence - a.confidence;
      if (Math.abs(confidenceDiff) > 0.1) {
        return confidenceDiff > 0 ? 1 : -1;
      }
      // Secondary: timestamp (newer first)
      return b.timestamp.getTime() - a.timestamp.getTime();
    });

    const optimized: WorklogEntry[] = [];
    let tokensUsed = 0;

    for (const worklogEntry of sortedWorklog) {
      const entryTokens = this.estimateWorklogTokens(worklogEntry);

      if (tokensUsed + entryTokens <= tokenBudget) {
        optimized.push(worklogEntry);
        tokensUsed += entryTokens;
      } else if (tokensUsed < tokenBudget) {
        // Try to include compressed version
        const remainingBudget = tokenBudget - tokensUsed;
        if (remainingBudget > 30) {
          // Smaller threshold for worklog entries
          const compressed = this.compressWorklogEntry(worklogEntry, remainingBudget);
          if (compressed) {
            optimized.push(compressed);
            break;
          }
        }
      }
    }

    return optimized;
  }

  /**
   * Estimates token count for a worklog entry.
   */
  private estimateWorklogTokens(worklogEntry: WorklogEntry): number {
    const titleTokens = this.estimateTokens(worklogEntry.title);
    const descriptionTokens = this.estimateTokens(worklogEntry.description);
    const metaTokens = this.estimateTokens(
      JSON.stringify({
        type: worklogEntry.type,
        outcome: worklogEntry.outcome,
        files_affected: worklogEntry.files_affected?.slice(0, 3), // Limit file count
        commands_used: worklogEntry.commands_used?.slice(0, 2), // Limit command count
      }),
    );

    return titleTokens + descriptionTokens + metaTokens;
  }

  /**
   * Compresses a worklog entry to fit within token budget.
   */
  private compressWorklogEntry(worklogEntry: WorklogEntry, maxTokens: number): WorklogEntry | null {
    if (this.estimateWorklogTokens(worklogEntry) <= maxTokens) {
      return worklogEntry;
    }

    // Try compressing description first
    const titleTokens = this.estimateTokens(worklogEntry.title);
    const metaTokens = this.estimateTokens(
      JSON.stringify({ type: worklogEntry.type, outcome: worklogEntry.outcome }),
    );

    const descriptionBudget = maxTokens - titleTokens - metaTokens - 10; // 10 token buffer

    if (descriptionBudget > 20) {
      const compressedDescription = this.compressContent(
        worklogEntry.description,
        descriptionBudget,
      );
      if (compressedDescription) {
        return {
          ...worklogEntry,
          description: compressedDescription,
          files_affected: worklogEntry.files_affected?.slice(0, 1), // Reduce metadata
          commands_used: worklogEntry.commands_used?.slice(0, 1),
        };
      }
    }

    return null;
  }

  /**
   * Builds enhanced prompt with session bridge and worklog context.
   */
  buildEnhancedPromptWithBridge(
    originalPrompt: string,
    workingMemories: MemoryEntry[],
    bridgeMemories: MemoryEntry[],
    worklogEntries: WorklogEntry[],
    tokenBudget: number,
    options?: {
      recentContext?: string;
      adaptiveAllocation?: boolean;
      contextFormat?: "detailed" | "summary" | "bullets";
      prioritizeBridge?: boolean;
    },
  ): EnhancedPrompt & {
    bridgeMemoriesIncluded: number;
    worklogEntriesIncluded: number;
    bridgeTokensUsed: number;
    worklogTokensUsed: number;
  } {
    const {
      recentContext = "",
      adaptiveAllocation = true,
      contextFormat = "summary",
      prioritizeBridge = true,
    } = options || {};

    // Calculate base token requirements
    const originalPromptTokens = this.estimateTokens(originalPrompt);
    const recentContextTokens = recentContext ? this.estimateTokens(recentContext) : 0;
    const bufferTokens = Math.floor(tokenBudget * 0.1); // 10% buffer

    // Calculate available memory budget
    const baseTokens = originalPromptTokens + recentContextTokens + bufferTokens;
    const memoryBudget = tokenBudget - baseTokens;

    if (memoryBudget <= 0) {
      // Not enough budget for enhanced context
      return {
        enhancedPrompt: recentContext ? `${recentContext}\n\n${originalPrompt}` : originalPrompt,
        originalPrompt,
        memoryContext: "",
        tokensUsed: baseTokens,
        memoriesIncluded: 0,
        memoryBreakdown: { working: 0, episodic: 0, semantic: 0, procedural: 0, contextual: 0 },
        bridgeMemoriesIncluded: 0,
        worklogEntriesIncluded: 0,
        bridgeTokensUsed: 0,
        worklogTokensUsed: 0,
      };
    }

    // Allocate memory budget
    const allocation = adaptiveAllocation
      ? this.adaptiveExtendedAllocation(
          workingMemories,
          bridgeMemories,
          worklogEntries,
          memoryBudget,
          prioritizeBridge,
        )
      : this.allocateExtendedTokens(memoryBudget);

    // Select and optimize content for each type
    const selectedWorking = this.selectMemoriesByType(
      workingMemories,
      "working",
      allocation.working_memory,
    );
    const selectedBridge = this.optimizeBridgeContent(bridgeMemories, allocation.session_bridge);
    const selectedWorklog = this.optimizeWorklogContent(worklogEntries, allocation.worklog_context);
    const selectedProcedural = this.selectMemoriesByType(
      workingMemories,
      "procedural",
      allocation.procedural_memory,
    );
    const selectedSemantic = this.selectMemoriesByType(
      workingMemories,
      "semantic",
      allocation.semantic_memory,
    );
    const selectedEpisodic = this.selectMemoriesByType(
      workingMemories,
      "episodic",
      allocation.episodic_memory,
    );

    // Format context sections
    const contextSections: string[] = [];

    if (selectedBridge.length > 0) {
      contextSections.push(this.formatBridgeContext(selectedBridge, contextFormat));
    }

    if (selectedWorklog.length > 0) {
      contextSections.push(this.formatWorklogContext(selectedWorklog, contextFormat));
    }

    const allSelectedMemories = [
      ...selectedWorking,
      ...selectedProcedural,
      ...selectedSemantic,
      ...selectedEpisodic,
    ];

    if (allSelectedMemories.length > 0) {
      // Group selected memories by type for context formatting
      logger.info(
        `Selected ${selectedWorking.length} working, ${selectedProcedural.length} procedural, ${selectedSemantic.length} semantic, ${selectedEpisodic.length} episodic memories`,
      );
      contextSections.push(this.formatMemoryContext(allSelectedMemories, contextFormat));
    }

    const memoryContext = contextSections.join("\n");

    // Build final prompt
    const promptParts = [];

    if (memoryContext) {
      promptParts.push(memoryContext);
    }

    if (recentContext) {
      promptParts.push("## RECENT CONTEXT");
      promptParts.push(recentContext);
    }

    promptParts.push("## USER REQUEST");
    promptParts.push(originalPrompt);

    const enhancedPrompt = promptParts.join("\n\n");
    const memoryContextTokens = this.estimateTokens(memoryContext);
    const totalTokens = originalPromptTokens + recentContextTokens + memoryContextTokens;

    // Calculate token usage
    const bridgeTokensUsed = selectedBridge.reduce(
      (sum, memory) => sum + this.estimateMemoryTokens(memory),
      0,
    );
    const worklogTokensUsed = selectedWorklog.reduce(
      (sum, entry) => sum + this.estimateWorklogTokens(entry),
      0,
    );

    return {
      enhancedPrompt,
      originalPrompt,
      memoryContext,
      tokensUsed: totalTokens,
      memoriesIncluded: allSelectedMemories.length,
      memoryBreakdown: {
        working: selectedWorking.length,
        contextual: selectedBridge.length,
        episodic: selectedEpisodic.length,
        semantic: selectedSemantic.length,
        procedural: selectedProcedural.length,
      },
      bridgeMemoriesIncluded: selectedBridge.length,
      worklogEntriesIncluded: selectedWorklog.length,
      bridgeTokensUsed,
      worklogTokensUsed,
    };
  }

  /**
   * Adaptive allocation considering bridge and worklog content.
   */
  private adaptiveExtendedAllocation(
    workingMemories: MemoryEntry[],
    bridgeMemories: MemoryEntry[],
    worklogEntries: WorklogEntry[],
    budget: number,
    prioritizeBridge: boolean,
  ): ExtendedTokenAllocation {
    const hasWorking = workingMemories.length > 0;
    const hasBridge = bridgeMemories.length > 0;
    const hasWorklog = worklogEntries.length > 0;

    // Base allocation
    const allocation = { ...this.EXTENDED_ALLOCATION };

    // Adjust based on content availability
    if (!hasBridge) {
      // Redistribute bridge allocation to working memory
      allocation.working_memory += allocation.session_bridge;
      allocation.session_bridge = 0;
    } else if (prioritizeBridge) {
      // Slightly increase bridge allocation at expense of semantic
      allocation.session_bridge += 0.03;
      allocation.semantic_memory -= 0.03;
    }

    if (!hasWorklog) {
      // Redistribute worklog allocation to episodic
      allocation.episodic_memory += allocation.worklog_context;
      allocation.worklog_context = 0;
    }

    if (!hasWorking) {
      // Redistribute working allocation to bridge and procedural
      const workingAllocation = allocation.working_memory;
      allocation.working_memory = 0;
      allocation.session_bridge += workingAllocation * 0.6;
      allocation.procedural_memory += workingAllocation * 0.4;
    }

    // Apply to budget and return
    return {
      working_memory: Math.floor(budget * allocation.working_memory),
      session_bridge: Math.floor(budget * allocation.session_bridge),
      procedural_memory: Math.floor(budget * allocation.procedural_memory),
      semantic_memory: Math.floor(budget * allocation.semantic_memory),
      episodic_memory: Math.floor(budget * allocation.episodic_memory),
      worklog_context: Math.floor(budget * allocation.worklog_context),
    };
  }

  /**
   * Selects memories of a specific type within token budget.
   */
  private selectMemoriesByType(
    memories: MemoryEntry[],
    type: MemoryType,
    budget: number,
  ): MemoryEntry[] {
    const typeMemories = memories
      .filter((m) => m.memoryType === type)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const selected: MemoryEntry[] = [];
    let tokensUsed = 0;

    for (const memory of typeMemories) {
      const memoryTokens = this.estimateMemoryTokens(memory);
      if (tokensUsed + memoryTokens <= budget) {
        selected.push(memory);
        tokensUsed += memoryTokens;
      }
    }

    return selected;
  }

  /**
   * Formats session bridge context for prompts.
   */
  private formatBridgeContext(bridgeMemories: MemoryEntry[], format: string): string {
    if (bridgeMemories.length === 0) return "";

    switch (format) {
      case "detailed":
        return `### Previous Session Context:\n${bridgeMemories
          .map((m, i) => `${i + 1}. ${this.extractContentText(m.content)}`)
          .join("\n")}\n`;
      case "bullets":
        return `## Previous Session:\n${bridgeMemories
          .map((m) => `• ${this.extractContentText(m.content, 120)}`)
          .join("\n")}\n`;
      default:
        return `[Previous Session: ${bridgeMemories
          .map((m) => this.extractContentText(m.content, 80))
          .join("; ")}]\n\n`;
    }
  }

  /**
   * Formats worklog context for prompts.
   */
  private formatWorklogContext(worklogEntries: WorklogEntry[], format: string): string {
    if (worklogEntries.length === 0) return "";

    switch (format) {
      case "detailed":
        return `### Recent Work Completed:\n${worklogEntries
          .map((w, i) => `${i + 1}. **${w.title}** (${w.outcome}): ${w.description}`)
          .join("\n")}\n`;
      case "bullets":
        return `## Recent Work:\n${worklogEntries
          .map((w) => `• [${w.outcome}] ${w.title}: ${w.description}`)
          .join("\n")}\n`;
      default:
        return `[Recent Work: ${worklogEntries
          .map((w) => `${w.title} (${w.outcome})`)
          .join(", ")}]\n\n`;
    }
  }

  /**
   * Estimates token count for memory entries (delegated to parent).
   */
  private estimateMemoryTokens(memory: MemoryEntry): number {
    const contentText = this.extractContentText(memory.content);
    return this.estimateTokens(contentText);
  }

  /**
   * Compresses memory content (delegated to parent).
   */
  private compressMemoryContent(memory: MemoryEntry, maxTokens: number): MemoryEntry | null {
    const contentText = this.extractContentText(memory.content);
    const compressed = this.compressContent(contentText, maxTokens);

    if (compressed) {
      return { ...memory, content: compressed };
    }

    return null;
  }

  /**
   * Extracts text content from memory (delegated to parent).
   */
  private extractContentText(content: string | Record<string, string>, maxLength?: number): string {
    let text = "";

    if (typeof content === "object" && content !== null) {
      const textFields = ["text", "content", "description", "statement", "summary", "title"];

      for (const field of textFields) {
        const contentObj = content;
        if (contentObj[field] && typeof contentObj[field] === "string") {
          text = contentObj[field];
          break;
        }
      }

      if (!text) {
        text = JSON.stringify(content)
          .replace(/[{}[\]"]/g, " ")
          .replace(/,/g, " ");
      }
    } else {
      text = String(content);
    }

    text = text.replace(/\s+/g, " ").trim();

    if (maxLength && text.length > maxLength) {
      text = `${text.substring(0, maxLength - 3)}...`;
    }

    return text;
  }

  /**
   * Compresses content to fit within token budget (delegated to parent).
   */
  private compressContent(content: string, maxTokens: number): string | null {
    if (this.estimateTokens(content) <= maxTokens) {
      return content;
    }

    // Try progressively shorter versions
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);

    for (let i = sentences.length; i > 0; i--) {
      const compressed = `${sentences.slice(0, i).join(". ")}.`;
      if (this.estimateTokens(compressed) <= maxTokens) {
        return compressed;
      }
    }

    // Last resort: truncate by estimated character count
    const maxChars = maxTokens * 4; // Avg chars per token
    if (content.length > maxChars) {
      return `${content.substring(0, maxChars - 3)}...`;
    }

    return null;
  }

  /**
   * Formats memory context (delegated to parent implementation).
   */
  private formatMemoryContext(
    memories: MemoryEntry[],
    format: "detailed" | "summary" | "bullets" = "summary",
  ): string {
    // This would call the parent class method - simplified for this implementation
    const groupedMemories = {
      working: memories.filter((m) => m.memoryType === "working"),
      contextual: memories.filter((m) => m.memoryType === "contextual"),
      procedural: memories.filter((m) => m.memoryType === "procedural"),
      semantic: memories.filter((m) => m.memoryType === "semantic"),
      episodic: memories.filter((m) => m.memoryType === "episodic"),
    };

    const parts: string[] = [];

    if (groupedMemories.working.length > 0) {
      parts.push(this.formatMemorySection("Working", groupedMemories.working, format));
    }

    if (groupedMemories.procedural.length > 0) {
      parts.push(this.formatMemorySection("Procedures", groupedMemories.procedural, format));
    }

    if (groupedMemories.semantic.length > 0) {
      parts.push(this.formatMemorySection("Knowledge", groupedMemories.semantic, format));
    }

    if (groupedMemories.episodic.length > 0) {
      parts.push(this.formatMemorySection("Experience", groupedMemories.episodic, format));
    }

    return parts.length > 0 ? `[Memory Context: ${parts.join(" | ")}]\n\n` : "";
  }

  /**
   * Formats a memory section based on the specified format.
   */
  private formatMemorySection(
    sectionName: string,
    memories: MemoryEntry[],
    format: "detailed" | "summary" | "bullets",
  ): string {
    switch (format) {
      case "detailed": {
        const content = memories.map((m) => this.extractContentText(m.content, 80)).join("; ");
        return `${sectionName}: ${content}`;
      }
      case "bullets": {
        const items = memories.map((m) => `• ${this.extractContentText(m.content, 60)}`).join("\n");
        return `${sectionName}:\n${items}`;
      }
      default: {
        // summary
        return `${sectionName}: ${memories.length} items`;
      }
    }
  }
}
