/**
 * Token Budget Manager for MECMF
 *
 * Implements intelligent token allocation and content optimization based on MECMF Section 2.5.2
 * and Section 7 (Token Management Strategies). Provides token-aware operations that ensure
 * efficient use of language model context windows.
 */

import {
  EnhancedPrompt,
  Memory,
  MemoryEntry,
  MemoryType,
  TokenAllocation,
  TokenBudgetManager,
} from "./mecmf-interfaces.ts";

export interface TokenEstimate {
  tokens: number;
  characters: number;
  words: number;
}

export interface OptimizationResult {
  optimizedContent: Memory[];
  tokensUsed: number;
  tokensAvailable: number;
  compressionRatio: number;
  removedContent: Memory[];
}

export interface PromptComponents {
  originalPrompt: string;
  memoryContext: string;
  recentContext: string;
  systemInstructions?: string;
}

export class AtlasTokenBudgetManager implements TokenBudgetManager {
  // Default token allocation percentages based on MECMF specification
  private readonly DEFAULT_ALLOCATION = {
    working_memory: 0.40, // 40% - immediate context
    procedural_memory: 0.25, // 25% - guidance and procedures
    semantic_memory: 0.25, // 25% - knowledge and facts
    episodic_memory: 0.10, // 10% - experiences
  };

  // Reserved token percentages for different prompt components
  private readonly PROMPT_ALLOCATION = {
    original_prompt: 0.30, // 30% - user request
    memory_content: 0.40, // 40% - memory context
    recent_context: 0.20, // 20% - conversation history
    buffer: 0.10, // 10% - safety buffer
  };

  // Token estimation constants (approximate)
  private readonly AVG_TOKENS_PER_WORD = 1.3;
  private readonly AVG_CHARS_PER_TOKEN = 4;

  calculateAvailableTokens(modelLimits: number, reservedTokens: number): number {
    const available = modelLimits - reservedTokens;
    return Math.max(0, available);
  }

  allocateTokensByType(budget: number): TokenAllocation {
    return {
      working_memory: Math.floor(budget * this.DEFAULT_ALLOCATION.working_memory),
      procedural_memory: Math.floor(budget * this.DEFAULT_ALLOCATION.procedural_memory),
      semantic_memory: Math.floor(budget * this.DEFAULT_ALLOCATION.semantic_memory),
      episodic_memory: Math.floor(budget * this.DEFAULT_ALLOCATION.episodic_memory),
    };
  }

  optimizeContentForBudget(content: Memory[], budget: number): Memory[] {
    if (content.length === 0) return [];

    // Sort by relevance score (descending)
    const sortedContent = [...content].sort((a, b) => b.relevanceScore - a.relevanceScore);

    const optimized: Memory[] = [];
    let tokensUsed = 0;

    for (const memory of sortedContent) {
      const estimatedTokens = this.estimateTokens(memory.content);

      if (tokensUsed + estimatedTokens <= budget) {
        optimized.push(memory);
        tokensUsed += estimatedTokens;
      } else if (tokensUsed < budget) {
        // Try to include a compressed version if there's remaining budget
        const remainingBudget = budget - tokensUsed;
        const compressedContent = this.compressContent(memory.content, remainingBudget);

        if (compressedContent && this.estimateTokens(compressedContent) <= remainingBudget) {
          optimized.push({
            ...memory,
            content: compressedContent,
            tokens: this.estimateTokens(compressedContent),
          });
          break;
        }
      }
    }

    return optimized;
  }

  /**
   * Build a token-aware enhanced prompt with memory context
   */
  buildTokenAwarePrompt(
    originalPrompt: string,
    memories: MemoryEntry[],
    tokenBudget: number,
    options?: {
      includeSystemInstructions?: boolean;
      recentContext?: string;
      adaptiveAllocation?: boolean;
      contextFormat?: "detailed" | "summary" | "bullets";
    },
  ): EnhancedPrompt {
    const {
      includeSystemInstructions: _includeSystemInstructions = false,
      recentContext = "",
      adaptiveAllocation = true,
      contextFormat = "summary",
    } = options || {};

    // Estimate token requirements for base components
    const originalPromptTokens = this.estimateTokens(originalPrompt);
    const recentContextTokens = recentContext ? this.estimateTokens(recentContext) : 0;

    // Calculate available tokens for memory content
    const baseTokens = originalPromptTokens + recentContextTokens;
    const bufferTokens = Math.floor(tokenBudget * this.PROMPT_ALLOCATION.buffer);
    const memoryBudget = tokenBudget - baseTokens - bufferTokens;

    if (memoryBudget <= 0 || memories.length === 0) {
      // Not enough budget for memory content, return basic prompt
      return {
        enhancedPrompt: recentContext ? `${recentContext}\n\n${originalPrompt}` : originalPrompt,
        originalPrompt,
        memoryContext: "",
        tokensUsed: baseTokens,
        memoriesIncluded: 0,
        memoryBreakdown: {
          [MemoryType.WORKING]: 0,
          [MemoryType.EPISODIC]: 0,
          [MemoryType.SEMANTIC]: 0,
          [MemoryType.PROCEDURAL]: 0,
        },
      };
    }

    // Allocate memory budget by type
    const allocation = adaptiveAllocation
      ? this.adaptiveTokenAllocation(memories, memoryBudget)
      : this.allocateTokensByType(memoryBudget);

    // Select and optimize memories for each type
    const selectedMemories = this.selectMemoriesByAllocation(memories, allocation);
    const memoryContext = this.formatMemoryContext(selectedMemories, contextFormat);
    const memoryContextTokens = this.estimateTokens(memoryContext);

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
    const totalTokens = originalPromptTokens + recentContextTokens + memoryContextTokens;

    // Calculate memory breakdown
    const memoryBreakdown = {
      [MemoryType.WORKING]:
        selectedMemories.filter((m) => m.memoryType === MemoryType.WORKING).length,
      [MemoryType.EPISODIC]:
        selectedMemories.filter((m) => m.memoryType === MemoryType.EPISODIC).length,
      [MemoryType.SEMANTIC]:
        selectedMemories.filter((m) => m.memoryType === MemoryType.SEMANTIC).length,
      [MemoryType.PROCEDURAL]:
        selectedMemories.filter((m) => m.memoryType === MemoryType.PROCEDURAL).length,
    };

    return {
      enhancedPrompt,
      originalPrompt,
      memoryContext,
      tokensUsed: totalTokens,
      memoriesIncluded: selectedMemories.length,
      memoryBreakdown,
    };
  }

  /**
   * Adaptive token allocation based on memory type distribution and characteristics
   */
  private adaptiveTokenAllocation(memories: MemoryEntry[], budget: number): TokenAllocation {
    // Analyze memory distribution
    const distribution = {
      working: memories.filter((m) => m.memoryType === MemoryType.WORKING).length,
      episodic: memories.filter((m) => m.memoryType === MemoryType.EPISODIC).length,
      semantic: memories.filter((m) => m.memoryType === MemoryType.SEMANTIC).length,
      procedural: memories.filter((m) => m.memoryType === MemoryType.PROCEDURAL).length,
    };

    const totalMemories = memories.length;
    if (totalMemories === 0) {
      return this.allocateTokensByType(budget);
    }

    // Calculate adaptive weights based on content availability and relevance
    let workingWeight = Math.max(0.20, Math.min(0.50, distribution.working / totalMemories));
    let proceduralWeight = Math.max(0.15, Math.min(0.35, distribution.procedural / totalMemories));
    let semanticWeight = Math.max(0.15, Math.min(0.35, distribution.semantic / totalMemories));
    let episodicWeight = Math.max(0.05, Math.min(0.20, distribution.episodic / totalMemories));

    // Normalize weights to sum to 1.0
    const totalWeight = workingWeight + proceduralWeight + semanticWeight + episodicWeight;
    workingWeight /= totalWeight;
    proceduralWeight /= totalWeight;
    semanticWeight /= totalWeight;
    episodicWeight /= totalWeight;

    return {
      working_memory: Math.floor(budget * workingWeight),
      procedural_memory: Math.floor(budget * proceduralWeight),
      semantic_memory: Math.floor(budget * semanticWeight),
      episodic_memory: Math.floor(budget * episodicWeight),
    };
  }

  /**
   * Select memories based on token allocation for each type
   */
  private selectMemoriesByAllocation(
    memories: MemoryEntry[],
    allocation: TokenAllocation,
  ): MemoryEntry[] {
    const selectedMemories: MemoryEntry[] = [];

    // Process each memory type
    const typeAllocations = [
      { type: MemoryType.WORKING, budget: allocation.working_memory },
      { type: MemoryType.PROCEDURAL, budget: allocation.procedural_memory },
      { type: MemoryType.SEMANTIC, budget: allocation.semantic_memory },
      { type: MemoryType.EPISODIC, budget: allocation.episodic_memory },
    ];

    for (const { type, budget } of typeAllocations) {
      if (budget <= 0) continue;

      const typeMemories = memories
        .filter((m) => m.memoryType === type)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

      let usedTokens = 0;
      for (const memory of typeMemories) {
        const memoryTokens = this.estimateMemoryTokens(memory);

        if (usedTokens + memoryTokens <= budget) {
          selectedMemories.push(memory);
          usedTokens += memoryTokens;
        } else if (usedTokens < budget && budget - usedTokens > 50) {
          // Try to include compressed version if significant budget remains
          const compressed = this.compressMemoryContent(memory, budget - usedTokens);
          if (compressed) {
            selectedMemories.push(compressed);
            break;
          }
        }
      }
    }

    return selectedMemories;
  }

  /**
   * Format memory context for inclusion in prompts
   */
  private formatMemoryContext(
    memories: MemoryEntry[],
    format: "detailed" | "summary" | "bullets",
  ): string {
    if (memories.length === 0) return "";

    const groupedMemories = {
      [MemoryType.WORKING]: memories.filter((m) => m.memoryType === MemoryType.WORKING),
      [MemoryType.PROCEDURAL]: memories.filter((m) => m.memoryType === MemoryType.PROCEDURAL),
      [MemoryType.SEMANTIC]: memories.filter((m) => m.memoryType === MemoryType.SEMANTIC),
      [MemoryType.EPISODIC]: memories.filter((m) => m.memoryType === MemoryType.EPISODIC),
    };

    switch (format) {
      case "detailed":
        return this.formatDetailedContext(groupedMemories);
      case "summary":
        return this.formatSummaryContext(groupedMemories);
      case "bullets":
        return this.formatBulletContext(groupedMemories);
      default:
        return this.formatSummaryContext(groupedMemories);
    }
  }

  private formatDetailedContext(groupedMemories: Record<MemoryType, MemoryEntry[]>): string {
    const sections: string[] = [];

    if (groupedMemories[MemoryType.WORKING].length > 0) {
      sections.push("### Current Working Context:");
      groupedMemories[MemoryType.WORKING].forEach((memory, index) => {
        sections.push(`${index + 1}. **${memory.id}**: ${this.extractContentText(memory.content)}`);
      });
    }

    if (groupedMemories[MemoryType.PROCEDURAL].length > 0) {
      sections.push("### Relevant Procedures & Workflows:");
      groupedMemories[MemoryType.PROCEDURAL].forEach((memory, index) => {
        sections.push(`${index + 1}. **${memory.id}**: ${this.extractContentText(memory.content)}`);
      });
    }

    if (groupedMemories[MemoryType.SEMANTIC].length > 0) {
      sections.push("### Relevant Knowledge:");
      groupedMemories[MemoryType.SEMANTIC].forEach((memory, index) => {
        sections.push(`${index + 1}. **${memory.id}**: ${this.extractContentText(memory.content)}`);
      });
    }

    if (groupedMemories[MemoryType.EPISODIC].length > 0) {
      sections.push("### Past Experiences:");
      groupedMemories[MemoryType.EPISODIC].forEach((memory, index) => {
        sections.push(`${index + 1}. **${memory.id}**: ${this.extractContentText(memory.content)}`);
      });
    }

    return sections.length > 0 ? `## RELEVANT MEMORY CONTEXT\n\n${sections.join("\n")}\n` : "";
  }

  private formatSummaryContext(groupedMemories: Record<MemoryType, MemoryEntry[]>): string {
    const parts: string[] = [];

    if (groupedMemories[MemoryType.WORKING].length > 0) {
      parts.push(`Current context: ${this.summarizeMemories(groupedMemories[MemoryType.WORKING])}`);
    }

    if (groupedMemories[MemoryType.PROCEDURAL].length > 0) {
      parts.push(`Procedures: ${this.summarizeMemories(groupedMemories[MemoryType.PROCEDURAL])}`);
    }

    if (groupedMemories[MemoryType.SEMANTIC].length > 0) {
      parts.push(`Knowledge: ${this.summarizeMemories(groupedMemories[MemoryType.SEMANTIC])}`);
    }

    if (groupedMemories[MemoryType.EPISODIC].length > 0) {
      parts.push(`Experience: ${this.summarizeMemories(groupedMemories[MemoryType.EPISODIC])}`);
    }

    return parts.length > 0 ? `[Memory Context: ${parts.join(" | ")}]\n\n` : "";
  }

  private formatBulletContext(groupedMemories: Record<MemoryType, MemoryEntry[]>): string {
    const bullets: string[] = [];

    for (const memory of groupedMemories[MemoryType.WORKING]) {
      bullets.push(`• [Working] ${this.extractContentText(memory.content, 120)}`);
    }

    for (const memory of groupedMemories[MemoryType.PROCEDURAL]) {
      bullets.push(`• [Procedure] ${this.extractContentText(memory.content, 120)}`);
    }

    for (const memory of groupedMemories[MemoryType.SEMANTIC]) {
      bullets.push(`• [Knowledge] ${this.extractContentText(memory.content, 120)}`);
    }

    for (const memory of groupedMemories[MemoryType.EPISODIC]) {
      bullets.push(`• [Experience] ${this.extractContentText(memory.content, 120)}`);
    }

    return bullets.length > 0 ? `## Relevant Memory:\n${bullets.join("\n")}\n\n` : "";
  }

  /**
   * Estimate token count for text content
   */
  estimateTokens(content: string): number {
    if (!content || content.trim().length === 0) return 0;

    // Simple heuristic: count words and apply token multiplier
    const words = content.trim().split(/\s+/).length;
    return Math.ceil(words * this.AVG_TOKENS_PER_WORD);
  }

  /**
   * Estimate token count for memory entry
   */
  private estimateMemoryTokens(memory: MemoryEntry): number {
    const contentText = this.extractContentText(memory.content);
    return this.estimateTokens(contentText);
  }

  /**
   * Extract text content from memory for token estimation
   */
  private extractContentText(content: any, maxLength?: number): string {
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (typeof content === "object" && content !== null) {
      const textFields = ["text", "content", "description", "statement", "summary", "title"];

      for (const field of textFields) {
        if (content[field] && typeof content[field] === "string") {
          text = content[field];
          break;
        }
      }

      if (!text) {
        text = JSON.stringify(content).replace(/[{}[\]"]/g, " ").replace(/,/g, " ");
      }
    } else {
      text = String(content);
    }

    text = text.replace(/\s+/g, " ").trim();

    if (maxLength && text.length > maxLength) {
      text = text.substring(0, maxLength - 3) + "...";
    }

    return text;
  }

  /**
   * Compress content to fit within token budget
   */
  private compressContent(content: string, maxTokens: number): string | null {
    if (this.estimateTokens(content) <= maxTokens) {
      return content;
    }

    // Try progressively shorter versions
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);

    for (let i = sentences.length; i > 0; i--) {
      const compressed = sentences.slice(0, i).join(". ") + ".";
      if (this.estimateTokens(compressed) <= maxTokens) {
        return compressed;
      }
    }

    // Last resort: truncate by estimated character count
    const maxChars = maxTokens * this.AVG_CHARS_PER_TOKEN;
    if (content.length > maxChars) {
      return content.substring(0, maxChars - 3) + "...";
    }

    return null;
  }

  /**
   * Compress memory content to fit budget
   */
  private compressMemoryContent(memory: MemoryEntry, maxTokens: number): MemoryEntry | null {
    const contentText = this.extractContentText(memory.content);
    const compressed = this.compressContent(contentText, maxTokens);

    if (compressed) {
      return {
        ...memory,
        content: typeof memory.content === "string"
          ? compressed
          : { ...memory.content, text: compressed },
      };
    }

    return null;
  }

  /**
   * Summarize multiple memories into a concise string
   */
  private summarizeMemories(memories: MemoryEntry[]): string {
    return memories
      .map((m) => this.extractContentText(m.content, 60))
      .join("; ");
  }

  /**
   * Progressive content optimization when approaching token limits
   */
  optimizeForTokenLimit(
    components: PromptComponents,
    targetTokens: number,
  ): { optimizedPrompt: string; tokensUsed: number; optimizations: string[] } {
    const optimizations: string[] = [];
    let { originalPrompt, memoryContext, recentContext, systemInstructions } = components;

    // Initial token estimate
    let currentTokens = this.estimateTokens(originalPrompt) +
      this.estimateTokens(memoryContext) +
      this.estimateTokens(recentContext || "") +
      this.estimateTokens(systemInstructions || "");

    // Phase 1: Compress memory context
    if (currentTokens > targetTokens && memoryContext) {
      const memoryBudget = targetTokens - this.estimateTokens(originalPrompt) -
        this.estimateTokens(recentContext || "") -
        this.estimateTokens(systemInstructions || "");

      if (memoryBudget > 0) {
        const compressed = this.compressContent(memoryContext, memoryBudget);
        if (compressed && compressed !== memoryContext) {
          memoryContext = compressed;
          optimizations.push("Compressed memory context");
        }
      }
    }

    // Phase 2: Truncate recent context
    if (currentTokens > targetTokens && recentContext) {
      const contextBudget = targetTokens - this.estimateTokens(originalPrompt) -
        this.estimateTokens(memoryContext) -
        this.estimateTokens(systemInstructions || "");

      if (contextBudget > 0) {
        const compressed = this.compressContent(recentContext, contextBudget);
        if (compressed && compressed !== recentContext) {
          recentContext = compressed;
          optimizations.push("Truncated recent context");
        }
      }
    }

    // Build optimized prompt
    const parts = [
      systemInstructions,
      memoryContext,
      recentContext,
      originalPrompt,
    ].filter(Boolean);

    const optimizedPrompt = parts.join("\n\n");
    const finalTokens = this.estimateTokens(optimizedPrompt);

    return {
      optimizedPrompt,
      tokensUsed: finalTokens,
      optimizations,
    };
  }
}

// Factory function
export function createTokenBudgetManager(): AtlasTokenBudgetManager {
  return new AtlasTokenBudgetManager();
}
