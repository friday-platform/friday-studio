/**
 * Debug Logger for MECMF Memory Enhancement
 *
 * Provides detailed logging of prompt transformation process to help understand
 * how MECMF enhances user prompts with memory context.
 */

import { CoALAMemoryType } from "./coala-memory.ts";

export interface PromptEnhancementLog {
  sessionId: string;
  timestamp: Date;
  originalPrompt: string;
  enhancedPrompt: string;
  memoryContext: string;
  tokensOriginal: number;
  tokensEnhanced: number;
  memoriesUsed: number;
  memoryBreakdown: Record<string, number>;
  transformationSteps: string[];
  performanceMetrics: {
    memoryRetrievalMs: number;
    classificationMs: number;
    embeddingMs: number;
    totalEnhancementMs: number;
  };
}

export interface MECMFDebugConfig {
  enabled: boolean;
  logLevel: "minimal" | "detailed" | "verbose";
  logToFile?: string;
  includeMemoryContent?: boolean;
  maxPromptLength?: number; // For truncating long prompts in logs
}

export class MECMFDebugLogger {
  private config: MECMFDebugConfig;
  private logs: PromptEnhancementLog[] = [];

  constructor(config: MECMFDebugConfig = { enabled: false, logLevel: "minimal" }) {
    this.config = { maxPromptLength: 500, includeMemoryContent: false, ...config };
  }

  logPromptEnhancement(log: PromptEnhancementLog): void {
    if (!this.config.enabled) return;

    // Store log entry
    this.logs.push(log);

    // Keep only last 100 log entries
    if (this.logs.length > 100) {
      this.logs.shift();
    }

    // Format and output debug information
    const output = this.formatLogEntry(log);

    // Use proper error channel since console methods don't work
    if (this.config.logToFile) {
      // In production, this could write to a file
      // For now, we'll prepare the log entry for external logging
    }

    // Emit log for debugging (can be captured by calling code)
    this.emitDebugLog(output);
  }

  private formatLogEntry(log: PromptEnhancementLog): string {
    const lines: string[] = [];
    const separator = "═".repeat(80);

    lines.push(`\n${separator}`);
    lines.push(`🧠 MECMF PROMPT ENHANCEMENT DEBUG LOG`);
    lines.push(`Session: ${log.sessionId}`);
    lines.push(`Timestamp: ${log.timestamp.toISOString()}`);
    lines.push(`${separator}`);

    // Original prompt
    const originalTruncated = this.truncateText(log.originalPrompt, this.config.maxPromptLength);
    lines.push(`📝 ORIGINAL PROMPT (${log.tokensOriginal} tokens):`);
    lines.push(`"${originalTruncated}"`);
    lines.push("");

    // Memory context analysis
    if (log.memoryContext && this.config.includeMemoryContent) {
      const contextTruncated = this.truncateText(log.memoryContext, this.config.maxPromptLength);
      lines.push(`🗃️ MEMORY CONTEXT ADDED:`);
      lines.push(`"${contextTruncated}"`);
      lines.push("");
    }

    // Memory breakdown
    lines.push(`📊 MEMORY BREAKDOWN (${log.memoriesUsed} memories used):`);
    Object.entries(log.memoryBreakdown).forEach(([type, count]) => {
      if (count > 0) {
        lines.push(`  ${this.getMemoryTypeIcon(type)} ${type}: ${count} memories`);
      }
    });
    lines.push("");

    // Token analysis
    const tokenChange = log.tokensEnhanced - log.tokensOriginal;
    const tokenChangePercent =
      log.tokensOriginal > 0 ? ((tokenChange / log.tokensOriginal) * 100).toFixed(1) : "N/A";

    lines.push(`🎯 TOKEN ANALYSIS:`);
    lines.push(`  Original: ${log.tokensOriginal} tokens`);
    lines.push(`  Enhanced: ${log.tokensEnhanced} tokens`);
    lines.push(
      `  Change: ${tokenChange >= 0 ? "+" : ""}${tokenChange} tokens (${tokenChangePercent}%)`,
    );
    lines.push("");

    // Performance metrics
    lines.push(`⚡ PERFORMANCE METRICS:`);
    lines.push(`  Memory Retrieval: ${log.performanceMetrics.memoryRetrievalMs}ms`);
    lines.push(`  Classification: ${log.performanceMetrics.classificationMs}ms`);
    lines.push(`  Embedding Generation: ${log.performanceMetrics.embeddingMs}ms`);
    lines.push(`  Total Enhancement: ${log.performanceMetrics.totalEnhancementMs}ms`);
    lines.push("");

    // Transformation steps
    if (this.config.logLevel === "verbose" && log.transformationSteps.length > 0) {
      lines.push(`🔄 TRANSFORMATION STEPS:`);
      log.transformationSteps.forEach((step, index) => {
        lines.push(`  ${index + 1}. ${step}`);
      });
      lines.push("");
    }

    // Enhanced prompt (truncated for readability)
    if (this.config.logLevel !== "minimal") {
      const enhancedTruncated = this.truncateText(
        log.enhancedPrompt,
        this.config.maxPromptLength * 2,
      );
      lines.push(`🚀 ENHANCED PROMPT (${log.tokensEnhanced} tokens):`);
      lines.push(`"${enhancedTruncated}"`);
      lines.push("");
    }

    // Summary
    const efficiencyGain =
      log.tokensOriginal > 0 && tokenChange < 0
        ? `Reduced tokens by ${Math.abs(Number(tokenChangePercent))}%`
        : tokenChange > 0
          ? `Added context (+${tokenChangePercent}% tokens)`
          : "No token change";

    lines.push(`✨ ENHANCEMENT SUMMARY:`);
    lines.push(`  Memories integrated: ${log.memoriesUsed}`);
    lines.push(`  Processing time: ${log.performanceMetrics.totalEnhancementMs}ms`);
    lines.push(`  Token efficiency: ${efficiencyGain}`);
    lines.push(`${separator}\n`);

    return lines.join("\n");
  }

  private getMemoryTypeIcon(type: string): string {
    // Handle both enum values and string literals for backward compatibility
    const normalizedType = type.toUpperCase();

    switch (normalizedType) {
      case CoALAMemoryType.WORKING:
        return "⚡";
      case CoALAMemoryType.EPISODIC:
        return "📖";
      case CoALAMemoryType.SEMANTIC:
        return "🧠";
      case CoALAMemoryType.PROCEDURAL:
        return "⚙️";
      default:
        return "📄";
    }
  }

  private truncateText(text: string, maxLength?: number): string {
    if (!maxLength || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + "...";
  }

  private emitDebugLog(logOutput: string): void {
    // This method can be overridden or extended to send logs to different destinations
    // For now, we'll store it for retrieval by external systems
    if (typeof Deno !== "undefined" && Deno.env.get("MECMF_DEBUG_LOGS") === "true") {
      // In development, you could enable this
      Deno.stderr.writeSync(new TextEncoder().encode(logOutput));
    }
  }

  // Utility methods for external access

  getRecentLogs(count: number = 10): PromptEnhancementLog[] {
    return this.logs.slice(-count);
  }

  getLogsForSession(sessionId: string): PromptEnhancementLog[] {
    return this.logs.filter((log) => log.sessionId === sessionId);
  }

  exportLogs(): PromptEnhancementLog[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }

  updateConfig(config: Partial<MECMFDebugConfig>): void {
    this.config = { ...this.config, ...config };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // Analysis methods

  getAverageEnhancementTime(): number {
    if (this.logs.length === 0) return 0;

    const totalTime = this.logs.reduce(
      (sum, log) => sum + log.performanceMetrics.totalEnhancementMs,
      0,
    );

    return totalTime / this.logs.length;
  }

  getTokenEfficiencyStats(): {
    averageOriginalTokens: number;
    averageEnhancedTokens: number;
    averageTokenChange: number;
    averageTokenChangePercent: number;
  } {
    if (this.logs.length === 0) {
      return {
        averageOriginalTokens: 0,
        averageEnhancedTokens: 0,
        averageTokenChange: 0,
        averageTokenChangePercent: 0,
      };
    }

    const totals = this.logs.reduce(
      (acc, log) => ({
        originalTokens: acc.originalTokens + log.tokensOriginal,
        enhancedTokens: acc.enhancedTokens + log.tokensEnhanced,
      }),
      { originalTokens: 0, enhancedTokens: 0 },
    );

    const averageOriginal = totals.originalTokens / this.logs.length;
    const averageEnhanced = totals.enhancedTokens / this.logs.length;
    const averageChange = averageEnhanced - averageOriginal;
    const averageChangePercent = averageOriginal > 0 ? (averageChange / averageOriginal) * 100 : 0;

    return {
      averageOriginalTokens: Math.round(averageOriginal),
      averageEnhancedTokens: Math.round(averageEnhanced),
      averageTokenChange: Math.round(averageChange),
      averageTokenChangePercent: Number(averageChangePercent.toFixed(2)),
    };
  }
}

// Global debug logger instance
let globalDebugLogger: MECMFDebugLogger | null = null;

export function getGlobalMECMFDebugLogger(): MECMFDebugLogger {
  if (!globalDebugLogger) {
    // Check environment variables for default configuration
    const debugEnabled =
      typeof Deno !== "undefined" &&
      (Deno.env.get("MECMF_DEBUG") === "true" || Deno.env.get("DEBUG") === "true");

    const debugLevel =
      typeof Deno !== "undefined"
        ? (Deno.env.get("MECMF_DEBUG_LEVEL") as MECMFDebugConfig["logLevel"]) || "detailed"
        : "detailed";

    globalDebugLogger = new MECMFDebugLogger({
      enabled: debugEnabled,
      logLevel: debugLevel,
      includeMemoryContent: true,
      maxPromptLength: 800,
    });
  }

  return globalDebugLogger;
}

export function enableMECMFDebugLogging(config?: Partial<MECMFDebugConfig>): void {
  const logger = getGlobalMECMFDebugLogger();
  logger.updateConfig({ enabled: true, ...config });
}

export function disableMECMFDebugLogging(): void {
  const logger = getGlobalMECMFDebugLogger();
  logger.updateConfig({ enabled: false });
}
