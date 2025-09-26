import type { EnhancedTokenBudgetManager } from "./enhanced-token-budget-manager.ts";
import type { MemoryEntry, WorklogEntry } from "./mecmf-interfaces.ts";

/**
 * Enum for context section types used in prompt assembly
 */
enum SectionType {
  BRIDGE = "bridge",
  WORKLOG = "worklog",
  WORKING = "working",
  PROCEDURAL = "procedural",
  SEMANTIC = "semantic",
  EPISODIC = "episodic",
}

/**
 * Enum for context format types used in prompt assembly
 */
export enum FormatType {
  DETAILED = "detailed",
  SUMMARY = "summary",
  BULLETS = "bullets",
}

/**
 * Enhanced prompt with session bridge and worklog context
 */
interface EnhancedContextPrompt {
  enhancedPrompt: string;
  originalPrompt: string;
  contextSections: {
    bridgeContext?: string;
    worklogContext?: string;
    workingContext?: string;
    proceduralContext?: string;
    semanticContext?: string;
    episodicContext?: string;
  };
  tokensUsed: number;
  compressionApplied: boolean;
  contextPriority: SectionType[];
}

/**
 * Context assembly options for customizing prompt construction
 */
interface ContextAssemblyOptions {
  format?: FormatType;
  prioritizeRecent?: boolean;
  includeMetadata?: boolean;
  maxContextLength?: number;
  adaptiveOrdering?: boolean;
  contextSeparator?: string;
  includeTimestamps?: boolean;
}

/**
 * ContextAssemblyService handles the intelligent assembly of enhanced prompts
 * with session bridge memories, worklog entries, and traditional memory types.
 */
export class ContextAssemblyService {
  private tokenManager: EnhancedTokenBudgetManager;

  constructor(tokenManager: EnhancedTokenBudgetManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Assembles an enhanced prompt with structured context sections.
   */
  async assembleEnhancedPrompt(
    originalPrompt: string,
    workingMemory: MemoryEntry[],
    bridgeMemory: MemoryEntry[],
    worklogEntries: WorklogEntry[],
    tokenBudget: number,
    options?: ContextAssemblyOptions,
  ): Promise<EnhancedContextPrompt> {
    const opts = this.getDefaultOptions(options);

    // Calculate base token requirements
    const baseTokens = this.tokenManager.estimateTokens(originalPrompt);
    const availableContextBudget = Math.max(
      0,
      tokenBudget - baseTokens - Math.floor(tokenBudget * 0.1),
    ); // 10% buffer

    if (availableContextBudget <= 0) {
      return {
        enhancedPrompt: originalPrompt,
        originalPrompt,
        contextSections: {},
        tokensUsed: baseTokens,
        compressionApplied: false,
        contextPriority: [],
      };
    }

    // Analyze and prioritize context sections
    const contextPriority = this.determineContextPriority(
      workingMemory,
      bridgeMemory,
      worklogEntries,
      opts,
    );

    // Build context sections with budget allocation
    const contextSections = await this.buildContextSections(
      workingMemory,
      bridgeMemory,
      worklogEntries,
      availableContextBudget,
      contextPriority,
      opts,
    );

    // Assemble final prompt
    const { enhancedPrompt, tokensUsed, compressionApplied } = this.assemblePrompt(
      originalPrompt,
      contextSections,
      contextPriority,
      opts,
    );

    return {
      enhancedPrompt,
      originalPrompt,
      contextSections,
      tokensUsed,
      compressionApplied,
      contextPriority,
    };
  }

  /**
   * Determines the priority order for context sections based on content and options.
   */
  private determineContextPriority(
    workingMemory: MemoryEntry[],
    bridgeMemory: MemoryEntry[],
    worklogEntries: WorklogEntry[],
    options: ContextAssemblyOptions,
  ): SectionType[] {
    const priority: Array<{ section: SectionType; score: number }> = [];

    // Score each section based on availability and relevance
    if (bridgeMemory.length > 0) {
      const avgRelevance =
        bridgeMemory.reduce((sum, m) => sum + m.relevanceScore, 0) / bridgeMemory.length;
      const recencyBonus = options.prioritizeRecent ? 0.2 : 0;
      priority.push({ section: SectionType.BRIDGE, score: avgRelevance + recencyBonus });
    }

    if (workingMemory.length > 0) {
      const workingRelevance =
        workingMemory.reduce((sum, m) => sum + m.relevanceScore, 0) / workingMemory.length;
      priority.push({ section: SectionType.WORKING, score: workingRelevance + 0.1 }); // Slight boost for current context
    }

    if (worklogEntries.length > 0) {
      const avgConfidence =
        worklogEntries.reduce((sum, w) => sum + w.confidence, 0) / worklogEntries.length;
      const institutionalBonus = 0.15; // Worklog provides institutional memory value
      priority.push({ section: SectionType.WORKLOG, score: avgConfidence + institutionalBonus });
    }

    // Add other memory types based on availability
    const proceduralMemories = workingMemory.filter((m) => m.memoryType === "procedural");
    if (proceduralMemories.length > 0) {
      const avgRelevance =
        proceduralMemories.reduce((sum, m) => sum + m.relevanceScore, 0) /
        proceduralMemories.length;
      priority.push({ section: SectionType.PROCEDURAL, score: avgRelevance });
    }

    const semanticMemories = workingMemory.filter((m) => m.memoryType === "semantic");
    if (semanticMemories.length > 0) {
      const avgRelevance =
        semanticMemories.reduce((sum, m) => sum + m.relevanceScore, 0) / semanticMemories.length;
      priority.push({ section: SectionType.SEMANTIC, score: avgRelevance });
    }

    const episodicMemories = workingMemory.filter((m) => m.memoryType === "episodic");
    if (episodicMemories.length > 0) {
      const avgRelevance =
        episodicMemories.reduce((sum, m) => sum + m.relevanceScore, 0) / episodicMemories.length;
      priority.push({ section: SectionType.EPISODIC, score: avgRelevance });
    }

    // Sort by score (highest first) and return section names
    return priority.sort((a, b) => b.score - a.score).map((p) => p.section);
  }

  /**
   * Builds context sections with intelligent budget allocation.
   */
  private buildContextSections(
    workingMemory: MemoryEntry[],
    bridgeMemory: MemoryEntry[],
    worklogEntries: WorklogEntry[],
    totalBudget: number,
    priority: SectionType[],
    options: ContextAssemblyOptions,
  ): {
    bridgeContext?: string;
    worklogContext?: string;
    workingContext?: string;
    proceduralContext?: string;
    semanticContext?: string;
    episodicContext?: string;
  } {
    const contextSections: Record<string, string> = {};
    let remainingBudget = totalBudget;
    const budgetPerSection = Math.floor(totalBudget / Math.max(1, priority.length));

    for (const sectionType of priority) {
      if (remainingBudget <= 0) break;

      const sectionBudget = Math.min(budgetPerSection, remainingBudget);
      let context: string | undefined;

      switch (sectionType) {
        case SectionType.BRIDGE:
          context = this.buildBridgeContext(bridgeMemory, sectionBudget, options);
          break;
        case SectionType.WORKLOG:
          context = this.buildWorklogContext(worklogEntries, sectionBudget, options);
          break;
        case SectionType.WORKING: {
          const workingMems = workingMemory.filter((m) => m.memoryType === "working");
          context = this.buildMemoryTypeContext(
            workingMems,
            "Working Context",
            sectionBudget,
            options,
          );
          break;
        }
        case SectionType.PROCEDURAL: {
          const proceduralMems = workingMemory.filter((m) => m.memoryType === "procedural");
          context = this.buildMemoryTypeContext(
            proceduralMems,
            "Procedures & Workflows",
            sectionBudget,
            options,
          );
          break;
        }
        case SectionType.SEMANTIC: {
          const semanticMems = workingMemory.filter((m) => m.memoryType === "semantic");
          context = this.buildMemoryTypeContext(
            semanticMems,
            "Knowledge Base",
            sectionBudget,
            options,
          );
          break;
        }
        case SectionType.EPISODIC: {
          const episodicMems = workingMemory.filter((m) => m.memoryType === "episodic");
          context = this.buildMemoryTypeContext(
            episodicMems,
            "Past Experiences",
            sectionBudget,
            options,
          );
          break;
        }
      }

      if (context) {
        contextSections[`${sectionType}Context`] = context;
        const contextTokens = this.tokenManager.estimateTokens(context);
        remainingBudget -= contextTokens;
      }
    }

    return contextSections;
  }

  /**
   * Builds bridge memory context section.
   */
  private buildBridgeContext(
    bridgeMemory: MemoryEntry[],
    budget: number,
    options: ContextAssemblyOptions,
  ): string | undefined {
    if (bridgeMemory.length === 0) return undefined;

    const optimized = this.tokenManager.optimizeBridgeContent(bridgeMemory, budget);
    if (optimized.length === 0) return undefined;

    const header = "## Previous Session Context";
    const separator = options.contextSeparator || "\n";

    switch (options.format) {
      case FormatType.DETAILED: {
        const detailedItems = optimized.map((memory, i) => {
          const content = this.extractContentText(memory.content);
          const timestamp = options.includeTimestamps
            ? ` (${this.formatTimestamp(memory.timestamp)})`
            : "";
          return `${i + 1}. ${content}${timestamp}`;
        });
        return `${header}${separator}${detailedItems.join(separator)}`;
      }

      case FormatType.BULLETS: {
        const bulletItems = optimized.map((memory) => {
          const content = this.extractContentText(memory.content, 120);
          return `• ${content}`;
        });
        return `${header}${separator}${bulletItems.join(separator)}`;
      }

      default: {
        // summary
        const summaries = optimized.map((memory) => this.extractContentText(memory.content, 80));
        return `[Previous Session: ${summaries.join("; ")}]`;
      }
    }
  }

  /**
   * Builds worklog context section.
   */
  private buildWorklogContext(
    worklogEntries: WorklogEntry[],
    budget: number,
    options: ContextAssemblyOptions,
  ): string | undefined {
    if (worklogEntries.length === 0) return undefined;

    const optimized = this.tokenManager.optimizeWorklogContent(worklogEntries, budget);
    if (optimized.length === 0) return undefined;

    const header = "## Recent Work Completed";
    const separator = options.contextSeparator || "\n";

    switch (options.format) {
      case FormatType.DETAILED: {
        const detailedItems = optimized.map((entry, i) => {
          const timestamp = options.includeTimestamps
            ? ` (${this.formatTimestamp(entry.timestamp)})`
            : "";
          const metadata = options.includeMetadata ? ` [${entry.type}]` : "";
          return `${
            i + 1
          }. **${entry.title}** (${entry.outcome})${metadata}: ${entry.description}${timestamp}`;
        });
        return `${header}${separator}${detailedItems.join(separator)}`;
      }

      case FormatType.BULLETS: {
        const bulletItems = optimized.map((entry) => {
          const outcomeIcon = this.getOutcomeIcon(entry.outcome);
          return `• ${outcomeIcon} ${entry.title}: ${entry.description}`;
        });
        return `${header}${separator}${bulletItems.join(separator)}`;
      }

      default: {
        // summary
        const summaries = optimized.map((entry) => `${entry.title} (${entry.outcome})`);
        return `[Recent Work: ${summaries.join(", ")}]`;
      }
    }
  }

  /**
   * Builds context for a specific memory type.
   */
  private buildMemoryTypeContext(
    memories: MemoryEntry[],
    header: string,
    budget: number,
    options: ContextAssemblyOptions,
  ): string | undefined {
    if (memories.length === 0) return undefined;

    // Sort by relevance and select within budget
    const sorted = memories.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const selected: MemoryEntry[] = [];
    let tokensUsed = 0;

    for (const memory of sorted) {
      const memoryTokens = this.tokenManager.estimateTokens(
        this.extractContentText(memory.content),
      );
      if (tokensUsed + memoryTokens <= budget) {
        selected.push(memory);
        tokensUsed += memoryTokens;
      }
    }

    if (selected.length === 0) return undefined;

    const separator = options.contextSeparator || "\n";

    switch (options.format) {
      case FormatType.DETAILED: {
        const detailedItems = selected.map((memory, i) => {
          const content = this.extractContentText(memory.content);
          const timestamp = options.includeTimestamps
            ? ` (${this.formatTimestamp(memory.timestamp)})`
            : "";
          return `${i + 1}. ${content}${timestamp}`;
        });
        return `## ${header}${separator}${detailedItems.join(separator)}`;
      }

      case FormatType.BULLETS: {
        const bulletItems = selected.map(
          (memory) => `• ${this.extractContentText(memory.content, 120)}`,
        );
        return `## ${header}${separator}${bulletItems.join(separator)}`;
      }

      default: {
        // summary
        const summaries = selected.map((memory) => this.extractContentText(memory.content, 60));
        return `[${header}: ${summaries.join("; ")}]`;
      }
    }
  }

  /**
   * Assembles the final prompt from context sections.
   */
  private assemblePrompt(
    originalPrompt: string,
    contextSections: Record<string, string>,
    priority: SectionType[],
    options: ContextAssemblyOptions,
  ): { enhancedPrompt: string; tokensUsed: number; compressionApplied: boolean } {
    const promptParts: string[] = [];
    let compressionApplied = false;

    // Add context sections in priority order
    for (const sectionType of priority) {
      const contextKey = `${sectionType}Context`;
      if (contextSections[contextKey]) {
        promptParts.push(contextSections[contextKey]);
      }
    }

    // Add original prompt at the end
    promptParts.push("## User Request");
    promptParts.push(originalPrompt);

    const enhancedPrompt = promptParts.join("\n\n");
    const tokensUsed = this.tokenManager.estimateTokens(enhancedPrompt);

    // Apply compression if needed
    if (options.maxContextLength && tokensUsed > options.maxContextLength) {
      // This could implement compression logic
      compressionApplied = true;
    }

    return { enhancedPrompt, tokensUsed, compressionApplied };
  }

  /**
   * Gets default options for context assembly.
   */
  private getDefaultOptions(options?: ContextAssemblyOptions): ContextAssemblyOptions {
    return {
      format: options?.format || FormatType.SUMMARY,
      prioritizeRecent: options?.prioritizeRecent ?? true,
      includeMetadata: options?.includeMetadata ?? false,
      maxContextLength: options?.maxContextLength,
      adaptiveOrdering: options?.adaptiveOrdering ?? true,
      contextSeparator: options?.contextSeparator || "\n",
      includeTimestamps: options?.includeTimestamps ?? false,
    };
  }

  /**
   * Extracts text content from various content formats.
   */
  private extractContentText(content: string | Record<string, string>, maxLength?: number): string {
    let text = "";

    if (typeof content === "object" && content !== null) {
      const textFields = ["text", "content", "description", "statement", "summary", "title"];

      for (const field of textFields) {
        if (content[field] && typeof content[field] === "string") {
          text = content[field];
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
      text = text.substring(0, maxLength - 3) + "...";
    }

    return text;
  }

  /**
   * Formats timestamp for display.
   */
  private formatTimestamp(timestamp: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) {
      return "< 1h ago";
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return timestamp.toLocaleDateString();
    }
  }

  /**
   * Gets icon for worklog entry outcome.
   */
  private getOutcomeIcon(outcome: string): string {
    switch (outcome) {
      case "success":
        return "✅";
      case "failure":
        return "❌";
      case "partial":
        return "⚠️";
      default:
        return "•";
    }
  }

  /**
   * Updates the token manager instance.
   */
  setTokenManager(tokenManager: EnhancedTokenBudgetManager): void {
    this.tokenManager = tokenManager;
  }

  /**
   * Gets context assembly statistics.
   */
  getAssemblyStatistics(): {
    totalPrompts: number;
    averageTokenUsage: number;
    compressionRate: number;
    contextTypesUsed: Record<string, number>;
  } {
    // This would typically track statistics in a real implementation
    return { totalPrompts: 0, averageTokenUsage: 0, compressionRate: 0, contextTypesUsed: {} };
  }
}
