import { logger } from "@atlas/logger";
import type { CompletionPattern, MemoryEntry, WorklogEntry } from "../mecmf-interfaces.ts";

/**
 * TaskCompletionDetector analyzes memory entries to identify completed tasks,
 * decisions, file modifications, and command executions for worklog generation.
 */
export class TaskCompletionDetector {
  private patterns: CompletionPattern[] = [
    {
      type: "task_completed",
      patterns: [
        "completed",
        "finished",
        "implemented",
        "done",
        "resolved",
        "fixed",
        "successfully",
        "created successfully",
        "updated successfully",
        "task complete",
        "implementation complete",
        "feature complete",
      ],
      extractionRule: "extractTask",
    },
    {
      type: "file_modified",
      patterns: [
        "created file",
        "edited file",
        "updated file",
        "modified file",
        "wrote to",
        "saved file",
        "file created at",
        "file updated at",
        "new file:",
        "modified:",
        "created:",
        "File created successfully",
      ],
      extractionRule: "extractFileChange",
    },
    {
      type: "command_executed",
      patterns: [
        "ran command",
        "executed",
        "running:",
        "npm install",
        "git commit",
        "git push",
        "npm run",
        "yarn",
        "deno run",
        "python",
        "node",
        "bash command:",
        "command executed:",
        "shell command:",
      ],
      extractionRule: "extractCommand",
    },
    {
      type: "decision_made",
      patterns: [
        "decided to",
        "chose to",
        "selected",
        "opted for",
        "determined that",
        "conclusion:",
        "decision:",
        "approach chosen:",
        "strategy:",
        "will use",
        "going with",
        "final decision",
      ],
      extractionRule: "extractDecision",
    },
  ];

  /**
   * Analyzes memory entries for completion patterns and extracts worklog entries.
   */
  async analyzeMemoryForCompletions(
    memories: MemoryEntry[],
    sessionId: string,
  ): Promise<WorklogEntry[]> {
    const worklogEntries: WorklogEntry[] = [];

    for (const memory of memories) {
      const detectedCompletions = await this.detectCompletions(memory, sessionId);
      worklogEntries.push(...detectedCompletions);
    }

    // Deduplicate similar entries
    return this.deduplicateEntries(worklogEntries);
  }

  /**
   * Detects completion patterns in a single memory entry.
   */
  private detectCompletions(memory: MemoryEntry, sessionId: string): WorklogEntry[] {
    const completions: WorklogEntry[] = [];
    const content = this.getMemoryContentAsString(memory);

    for (const pattern of this.patterns) {
      if (this.matchesPattern(content, pattern)) {
        const worklogEntry = this.extractWorklogEntry(memory, pattern, sessionId, content);
        if (worklogEntry && worklogEntry.confidence > 0.5) {
          completions.push(worklogEntry);
        }
      }
    }

    return completions;
  }

  /**
   * Checks if content matches any pattern for a completion type.
   */
  private matchesPattern(content: string, pattern: CompletionPattern): boolean {
    const lowerContent = content.toLowerCase();
    return pattern.patterns.some((p) => lowerContent.includes(p.toLowerCase()));
  }

  /**
   * Extracts a worklog entry based on the detected pattern.
   */
  private extractWorklogEntry(
    memory: MemoryEntry,
    pattern: CompletionPattern,
    sessionId: string,
    content: string,
  ): WorklogEntry | null {
    try {
      switch (pattern.extractionRule) {
        case "extractTask":
          return this.extractTask(memory, sessionId, content);
        case "extractFileChange":
          return this.extractFileChange(memory, sessionId, content);
        case "extractCommand":
          return this.extractCommand(memory, sessionId, content);
        case "extractDecision":
          return this.extractDecision(memory, sessionId, content);
        default:
          return null;
      }
    } catch (error) {
      logger.warn(`Failed to extract worklog entry for pattern ${pattern.type}:`, { error });
      return null;
    }
  }

  /**
   * Extracts task completion information.
   */
  private extractTask(memory: MemoryEntry, sessionId: string, content: string): WorklogEntry {
    const title = this.extractTitle(content, "Task completed");
    const description = this.extractDescription(content, 100);
    const outcome = this.determineOutcome(content);
    const filesAffected = this.extractFilePaths(content);
    const nextActions = this.extractNextActions(content);

    return {
      id: this.generateId("task", memory.id),
      timestamp: new Date(),
      session_id: sessionId,
      type: "task_completed",
      title,
      description,
      outcome,
      files_affected: filesAffected,
      next_actions: nextActions,
      tags: [...memory.tags, "auto_detected", "task_completion"],
      confidence: this.calculateConfidence(content, "task_completed"),
    };
  }

  /**
   * Extracts file modification information.
   */
  private extractFileChange(memory: MemoryEntry, sessionId: string, content: string): WorklogEntry {
    const filesAffected = this.extractFilePaths(content);
    const title =
      filesAffected.length > 0
        ? `Modified ${filesAffected[0]}${
            filesAffected.length > 1 ? ` and ${filesAffected.length - 1} other files` : ""
          }`
        : "File modified";

    const description = this.extractDescription(content, 100);
    const outcome = this.determineOutcome(content);

    return {
      id: this.generateId("file", memory.id),
      timestamp: new Date(),
      session_id: sessionId,
      type: "file_modified",
      title,
      description,
      outcome,
      files_affected: filesAffected,
      tags: [...memory.tags, "auto_detected", "file_modification"],
      confidence: this.calculateConfidence(content, "file_modified"),
    };
  }

  /**
   * Extracts command execution information.
   */
  private extractCommand(memory: MemoryEntry, sessionId: string, content: string): WorklogEntry {
    const commands = this.extractCommands(content);
    const title =
      commands.length > 0
        ? `Executed: ${commands[0]}${
            commands.length > 1 ? ` and ${commands.length - 1} other commands` : ""
          }`
        : "Command executed";

    const description = this.extractDescription(content, 100);
    const outcome = this.determineOutcome(content);

    return {
      id: this.generateId("command", memory.id),
      timestamp: new Date(),
      session_id: sessionId,
      type: "command_executed",
      title,
      description,
      outcome,
      commands_used: commands,
      tags: [...memory.tags, "auto_detected", "command_execution"],
      confidence: this.calculateConfidence(content, "command_executed"),
    };
  }

  /**
   * Extracts decision-making information.
   */
  private extractDecision(memory: MemoryEntry, sessionId: string, content: string): WorklogEntry {
    const title = this.extractTitle(content, "Decision made");
    const description = this.extractDescription(content, 150);
    const outcome = this.determineOutcome(content);

    return {
      id: this.generateId("decision", memory.id),
      timestamp: new Date(),
      session_id: sessionId,
      type: "decision_made",
      title,
      description,
      outcome,
      tags: [...memory.tags, "auto_detected", "decision"],
      confidence: this.calculateConfidence(content, "decision_made"),
    };
  }

  /**
   * Extracts file paths from content.
   */
  private extractFilePaths(content: string): string[] {
    const pathPatterns = [
      // Absolute paths
      /\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g,
      // Relative paths with extensions
      /[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g,
      // Common project paths
      /src\/[a-zA-Z0-9_\-./]+/g,
      /packages\/[a-zA-Z0-9_\-./]+/g,
    ];

    const paths = new Set<string>();

    for (const pattern of pathPatterns) {
      const matches = content.match(pattern) || [];
      matches.forEach((match) => {
        if (match.includes(".") && match.length > 3) {
          paths.add(match);
        }
      });
    }

    return Array.from(paths).slice(0, 10); // Limit to 10 files
  }

  /**
   * Extracts command strings from content.
   */
  private extractCommands(content: string): string[] {
    const commandPatterns = [
      /(?:ran command|executed|running:)\s*["`']?([^"`'\n]+)["`']?/gi,
      /(?:npm|yarn|deno|python|node|git)\s+[a-zA-Z0-9_\-\s]+/gi,
    ];

    const commands = new Set<string>();

    for (const pattern of commandPatterns) {
      const matches = content.match(pattern) || [];
      matches.forEach((match) => {
        const cleanCommand = match.replace(/(?:ran command|executed|running:)\s*/gi, "").trim();
        if (cleanCommand.length > 2) {
          commands.add(cleanCommand);
        }
      });
    }

    return Array.from(commands).slice(0, 5); // Limit to 5 commands
  }

  /**
   * Extracts next action items from content.
   */
  private extractNextActions(content: string): string[] {
    const actionPatterns = [
      /(?:next|todo|need to|should|will)\s+([^.!?\n]+)/gi,
      /(?:action|step|task):\s*([^.!?\n]+)/gi,
    ];

    const actions = new Set<string>();

    for (const pattern of actionPatterns) {
      const matches = content.match(pattern) || [];
      matches.forEach((match) => {
        const cleanAction = match
          .replace(/(?:next|todo|need to|should|will|action|step|task):\s*/gi, "")
          .trim();
        if (cleanAction.length > 5) {
          actions.add(cleanAction);
        }
      });
    }

    return Array.from(actions).slice(0, 3); // Limit to 3 actions
  }

  /**
   * Determines the outcome of an operation based on content.
   */
  private determineOutcome(content: string): "success" | "failure" | "partial" {
    const lowerContent = content.toLowerCase();

    const successIndicators = ["success", "completed", "done", "fixed", "resolved", "working"];
    const failureIndicators = ["error", "failed", "broken", "issue", "problem", "exception"];
    const partialIndicators = ["partial", "incomplete", "in progress", "ongoing"];

    if (partialIndicators.some((indicator) => lowerContent.includes(indicator))) {
      return "partial";
    }

    if (failureIndicators.some((indicator) => lowerContent.includes(indicator))) {
      return "failure";
    }

    if (successIndicators.some((indicator) => lowerContent.includes(indicator))) {
      return "success";
    }

    return "partial"; // Default to partial if unclear
  }

  /**
   * Calculates confidence score for extraction accuracy.
   */
  private calculateConfidence(content: string, type: string): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on specific indicators
    const lowerContent = content.toLowerCase();

    if (
      type === "task_completed" &&
      (lowerContent.includes("completed") || lowerContent.includes("finished"))
    ) {
      confidence += 0.3;
    }

    if (
      type === "file_modified" &&
      lowerContent.includes("file") &&
      lowerContent.includes("created")
    ) {
      confidence += 0.3;
    }

    if (
      type === "command_executed" &&
      (lowerContent.includes("executed") || lowerContent.includes("ran"))
    ) {
      confidence += 0.3;
    }

    // Decrease confidence if content is too short or vague
    if (content.length < 20) {
      confidence -= 0.2;
    }

    return Math.min(1.0, Math.max(0.1, confidence));
  }

  /**
   * Extracts a meaningful title from content.
   */
  private extractTitle(content: string, defaultTitle: string): string {
    const sentences = content.split(/[.!?]/).filter((s) => s.trim().length > 0);
    if (sentences.length > 0) {
      const firstSentence = sentences[0]?.trim() ?? "";
      if (firstSentence.length > 5 && firstSentence.length < 80) {
        return firstSentence;
      }
    }

    return defaultTitle;
  }

  /**
   * Extracts a description, limiting length.
   */
  private extractDescription(content: string, maxLength: number): string {
    const cleaned = content.replace(/\s+/g, " ").trim();
    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return `${cleaned.substring(0, maxLength - 3)}...`;
  }

  /**
   * Generates a unique ID for worklog entries.
   */
  private generateId(prefix: string, memoryId: string): string {
    const timestamp = Date.now();
    return `worklog_${prefix}_${memoryId}_${timestamp}`;
  }

  /**
   * Converts memory content to string for analysis.
   */
  private getMemoryContentAsString(memory: MemoryEntry): string {
    if (typeof memory.content === "string") {
      return memory.content;
    }

    if (typeof memory.content === "object") {
      return JSON.stringify(memory.content);
    }

    return String(memory.content);
  }

  /**
   * Removes duplicate worklog entries based on similarity.
   */
  private deduplicateEntries(entries: WorklogEntry[]): WorklogEntry[] {
    const unique: WorklogEntry[] = [];

    for (const entry of entries) {
      const isDuplicate = unique.some(
        (existing) =>
          existing.type === entry.type &&
          existing.title === entry.title &&
          Math.abs(existing.timestamp.getTime() - entry.timestamp.getTime()) < 10000, // Within 10 seconds
      );

      if (!isDuplicate) {
        unique.push(entry);
      }
    }

    return unique;
  }

  /**
   * Updates detection patterns (for learning and improvement).
   */
  updatePatterns(newPatterns: CompletionPattern[]): void {
    this.patterns = [...this.patterns, ...newPatterns];
  }

  /**
   * Gets current detection statistics.
   */
  getDetectionStatistics(): { totalPatterns: number; patternsByType: Record<string, number> } {
    const patternsByType: Record<string, number> = {};

    for (const pattern of this.patterns) {
      patternsByType[pattern.type] = (patternsByType[pattern.type] || 0) + pattern.patterns.length;
    }

    return {
      totalPatterns: this.patterns.reduce((sum, p) => sum + p.patterns.length, 0),
      patternsByType,
    };
  }
}
