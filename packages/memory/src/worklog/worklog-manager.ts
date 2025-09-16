import { logger } from "@atlas/logger";
import {
  type MECMFEmbeddingProvider,
  type MECMFMemoryManager,
  type MemoryEntry,
  MemorySource,
  MemoryType,
  type WorklogEntry,
  type WorklogMemoryEntry,
} from "../mecmf-interfaces.ts";
import { TaskCompletionDetector } from "./completion-detector.ts";

/**
 * WorklogManager handles the creation, storage, and retrieval of worklog entries
 * from completed tasks, providing structured episodic memory for institutional knowledge.
 */
export class WorklogManager {
  private detector: TaskCompletionDetector;
  private memoryManager: MECMFMemoryManager;
  private embeddingProvider: MECMFEmbeddingProvider;
  private config: {
    confidence_threshold: number;
    max_entries_per_session: number;
    retention_days: number;
  };

  constructor(
    memoryManager: MECMFMemoryManager,
    embeddingProvider: MECMFEmbeddingProvider,
    config?: {
      confidence_threshold?: number;
      max_entries_per_session?: number;
      retention_days?: number;
    },
  ) {
    this.memoryManager = memoryManager;
    this.embeddingProvider = embeddingProvider;
    this.detector = new TaskCompletionDetector();
    this.config = {
      confidence_threshold: config?.confidence_threshold ?? 0.7,
      max_entries_per_session: config?.max_entries_per_session ?? 20,
      retention_days: config?.retention_days ?? 90,
    };
  }

  /**
   * Processes a session's working memory to generate worklog entries.
   */
  async processSessionWorklog(
    sessionId: string,
    workingMemories: MemoryEntry[],
  ): Promise<WorklogEntry[]> {
    try {
      logger.info(
        `Processing worklog for session ${sessionId} with ${workingMemories.length} memories`,
      );

      // 1. Detect completed items using patterns
      const detectedEntries = await this.detector.analyzeMemoryForCompletions(
        workingMemories,
        sessionId,
      );

      // 2. Filter by confidence threshold
      const highConfidenceEntries = detectedEntries.filter(
        (entry) => entry.confidence >= this.config.confidence_threshold,
      );

      // 3. Limit entries per session to prevent bloat
      const limitedEntries = highConfidenceEntries
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, this.config.max_entries_per_session);

      // 4. Create WorklogMemoryEntry instances and store in episodic memory
      const storedEntries: WorklogEntry[] = [];
      for (const worklogEntry of limitedEntries) {
        try {
          const worklogMemoryEntry = await this.createWorklogMemoryEntry(worklogEntry);
          await this.memoryManager.storeMemory(worklogMemoryEntry);
          storedEntries.push(worklogEntry);
        } catch (error) {
          logger.error(`Failed to store worklog entry ${worklogEntry.id}:`, { error });
        }
      }

      logger.info(`Stored ${storedEntries.length} worklog entries for session ${sessionId}`);
      return storedEntries;
    } catch (error) {
      logger.error(`Failed to process session worklog for ${sessionId}:`, { error });
      return [];
    }
  }

  /**
   * Retrieves recent worklog entries for context loading.
   */
  async getRecentWorklog(days: number = 7): Promise<WorklogEntry[]> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      // Get all episodic memories that are worklog entries
      const episodicMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: 1000,
        maxAge: days * 24 * 60 * 60 * 1000, // Convert days to milliseconds
      });

      // Filter for worklog entries and extract worklog data
      const worklogEntries: WorklogEntry[] = [];
      for (const memory of episodicMemories) {
        if (this.isWorklogMemoryEntry(memory) && memory.timestamp >= cutoffDate) {
          worklogEntries.push(memory.worklog_data);
        }
      }

      // Sort by relevance and recency
      return worklogEntries
        .sort((a, b) => {
          // Primary sort: timestamp (newer first)
          const timeDiff = b.timestamp.getTime() - a.timestamp.getTime();
          if (Math.abs(timeDiff) > 24 * 60 * 60 * 1000) {
            // More than 1 day difference
            return timeDiff > 0 ? 1 : -1;
          }
          // Secondary sort: confidence (higher first)
          return b.confidence - a.confidence;
        })
        .slice(0, 50); // Limit to 50 recent entries
    } catch (error) {
      logger.error("Failed to get recent worklog entries:", { error });
      return [];
    }
  }

  /**
   * Performs semantic search through worklog entries.
   */
  async searchWorklog(query: string, maxResults: number = 10): Promise<WorklogEntry[]> {
    try {
      // Generate embedding for the search query
      // Generate embedding for better search relevance
      await this.embeddingProvider.generateEmbedding(query);

      // Search for similar memories in episodic memory
      const similarMemories = await this.memoryManager.getRelevantMemories(query, {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: maxResults * 2, // Get more candidates to filter
        minRelevanceScore: 0.3,
      });

      // Filter for worklog entries and extract worklog data
      const worklogEntries: WorklogEntry[] = [];
      for (const memory of similarMemories) {
        if (this.isWorklogMemoryEntry(memory)) {
          worklogEntries.push(memory.worklog_data);
        }
      }

      // Sort by relevance and limit results
      return worklogEntries.sort((a, b) => b.confidence - a.confidence).slice(0, maxResults);
    } catch (error) {
      logger.error("Failed to search worklog entries:", { error });
      return [];
    }
  }

  /**
   * Gets worklog entries for a specific session.
   */
  async getSessionWorklog(sessionId: string): Promise<WorklogEntry[]> {
    try {
      const episodicMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: 1000,
      });

      const sessionWorklogEntries: WorklogEntry[] = [];
      for (const memory of episodicMemories) {
        if (this.isWorklogMemoryEntry(memory)) {
          const worklogData = memory.worklog_data;
          if (worklogData.session_id === sessionId) {
            sessionWorklogEntries.push(worklogData);
          }
        }
      }

      return sessionWorklogEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (error) {
      logger.error(`Failed to get worklog for session ${sessionId}:`, { error });
      return [];
    }
  }

  /**
   * Gets worklog entries by type.
   */
  async getWorklogByType(
    type: "task_completed" | "decision_made" | "file_modified" | "command_executed",
    maxResults: number = 50,
  ): Promise<WorklogEntry[]> {
    try {
      const episodicMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: maxResults * 2,
      });

      const typeEntries: WorklogEntry[] = [];
      for (const memory of episodicMemories) {
        if (this.isWorklogMemoryEntry(memory)) {
          const worklogData = memory.worklog_data;
          if (worklogData.type === type) {
            typeEntries.push(worklogData);
          }
        }
      }

      return typeEntries
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, maxResults);
    } catch (error) {
      logger.error(`Failed to get worklog entries of type ${type}:`, { error });
      return [];
    }
  }

  /**
   * Gets worklog statistics and insights.
   */
  async getWorklogStatistics(): Promise<{
    totalEntries: number;
    entriesByType: Record<string, number>;
    entriesByOutcome: Record<string, number>;
    averageConfidence: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
    topFiles: string[];
    topCommands: string[];
  }> {
    try {
      const episodicMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: 10000, // Get all worklog entries
      });

      const worklogEntries: WorklogEntry[] = [];
      for (const memory of episodicMemories) {
        if (this.isWorklogMemoryEntry(memory)) {
          worklogEntries.push(memory.worklog_data);
        }
      }

      if (worklogEntries.length === 0) {
        return {
          totalEntries: 0,
          entriesByType: {},
          entriesByOutcome: {},
          averageConfidence: 0,
          oldestEntry: null,
          newestEntry: null,
          topFiles: [],
          topCommands: [],
        };
      }

      // Calculate statistics
      const entriesByType: Record<string, number> = {};
      const entriesByOutcome: Record<string, number> = {};
      const allFiles: string[] = [];
      const allCommands: string[] = [];
      let totalConfidence = 0;

      for (const entry of worklogEntries) {
        entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
        entriesByOutcome[entry.outcome] = (entriesByOutcome[entry.outcome] || 0) + 1;
        totalConfidence += entry.confidence;

        if (entry.files_affected) {
          allFiles.push(...entry.files_affected);
        }
        if (entry.commands_used) {
          allCommands.push(...entry.commands_used);
        }
      }

      // Get top files and commands
      const fileFreq = this.getFrequencyMap(allFiles);
      const commandFreq = this.getFrequencyMap(allCommands);

      const timestamps = worklogEntries.map((e) => e.timestamp.getTime());

      return {
        totalEntries: worklogEntries.length,
        entriesByType,
        entriesByOutcome,
        averageConfidence: totalConfidence / worklogEntries.length,
        oldestEntry: new Date(Math.min(...timestamps)),
        newestEntry: new Date(Math.max(...timestamps)),
        topFiles: Object.entries(fileFreq)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([file]) => file),
        topCommands: Object.entries(commandFreq)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([cmd]) => cmd),
      };
    } catch (error) {
      logger.error("Failed to get worklog statistics:", { error });
      return {
        totalEntries: 0,
        entriesByType: {},
        entriesByOutcome: {},
        averageConfidence: 0,
        oldestEntry: null,
        newestEntry: null,
        topFiles: [],
        topCommands: [],
      };
    }
  }

  /**
   * Manually adds a worklog entry (for user corrections/additions).
   */
  async addManualWorklogEntry(entry: Omit<WorklogEntry, "id" | "timestamp">): Promise<string> {
    const worklogEntry: WorklogEntry = {
      ...entry,
      id: `manual_worklog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };

    const worklogMemoryEntry = await this.createWorklogMemoryEntry(worklogEntry);
    await this.memoryManager.storeMemory(worklogMemoryEntry);

    return worklogEntry.id;
  }

  /**
   * Prunes old worklog entries based on retention policy.
   */
  async pruneOldWorklogEntries(): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retention_days);

      const episodicMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.EPISODIC],
        maxResults: 10000,
      });

      let prunedCount = 0;
      for (const memory of episodicMemories) {
        if (this.isWorklogMemoryEntry(memory) && memory.timestamp < cutoffDate) {
          try {
            await this.memoryManager.deleteMemory(memory.id);
            prunedCount++;
          } catch (error) {
            logger.error(`Failed to delete old worklog entry ${memory.id}:`, { error });
          }
        }
      }

      if (prunedCount > 0) {
        logger.info(`Pruned ${prunedCount} old worklog entries`);
      }

      return prunedCount;
    } catch (error) {
      logger.error("Failed to prune old worklog entries:", { error });
      return 0;
    }
  }

  /**
   * Creates a WorklogMemoryEntry from a WorklogEntry.
   */
  private async createWorklogMemoryEntry(worklogEntry: WorklogEntry): Promise<WorklogMemoryEntry> {
    // Generate embedding for semantic search
    const embeddingText = `${worklogEntry.title} ${worklogEntry.description} ${worklogEntry.tags.join(
      " ",
    )}`;
    const embedding = await this.embeddingProvider.generateEmbedding(embeddingText);

    return {
      id: `memory_${worklogEntry.id}`,
      content: worklogEntry.description,
      timestamp: worklogEntry.timestamp,
      memoryType: MemoryType.EPISODIC,
      relevanceScore: worklogEntry.confidence,
      sourceScope: `session_${worklogEntry.session_id}`,
      tags: [...worklogEntry.tags, "worklog_entry", `type_${worklogEntry.type}`],
      confidence: worklogEntry.confidence,
      decayRate: 0.1, // Slow decay for institutional memory
      embedding,
      source: MemorySource.SYSTEM_GENERATED,
      sourceMetadata: { sessionId: worklogEntry.session_id, agentId: "worklog_manager" },
      subtype: "worklog",
      worklog_data: worklogEntry,
    };
  }

  /**
   * Type guard to check if a memory entry is a worklog entry.
   */
  private isWorklogMemoryEntry(memory: MemoryEntry): memory is WorklogMemoryEntry {
    return (
      memory.memoryType === MemoryType.EPISODIC &&
      "subtype" in memory &&
      memory.subtype === "worklog" &&
      "worklog_data" in memory
    );
  }

  /**
   * Calculates frequency map for arrays of strings.
   */
  private getFrequencyMap(items: string[]): Record<string, number> {
    const freq: Record<string, number> = {};
    for (const item of items) {
      if (item.trim()) {
        freq[item] = (freq[item] || 0) + 1;
      }
    }
    return freq;
  }

  /**
   * Updates configuration for the worklog manager.
   */
  updateConfig(
    newConfig: Partial<{
      confidence_threshold: number;
      max_entries_per_session: number;
      retention_days: number;
    }>,
  ): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Starts monitoring a session for worklog generation.
   */
  startSessionMonitoring(sessionId: string): void {
    logger.info(`Started worklog monitoring for session ${sessionId}`);
    // This could set up real-time monitoring if needed
  }

  /**
   * Stops monitoring a session.
   */
  stopSessionMonitoring(sessionId: string): void {
    logger.info(`Stopped worklog monitoring for session ${sessionId}`);
    // Clean up any session-specific monitoring
  }
}
