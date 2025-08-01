import { join } from "@std/path";
import { exists } from "@std/fs";
import { logger } from "@atlas/logger";

export interface PatternSolution {
  pattern: string;
  solution: any;
  confidence: number;
  usageCount: number;
  lastUsed: Date;
}

export interface PlanningContext {
  task: string;
  agentType: string;
  complexity: number;
  requiresToolUse: boolean;
  qualityCritical: boolean;
}

export class PatternMatcher {
  private patterns = new Map<string, PatternSolution>();
  private atlasDir: string;
  private logger = logger;

  constructor(workspaceRoot: string) {
    this.atlasDir = join(workspaceRoot, ".atlas");
  }

  async loadPatterns(): Promise<void> {
    try {
      const patternsPath = join(this.atlasDir, "performance", "pattern-cache.json");

      if (!await exists(patternsPath)) {
        return;
      }

      const patternsData = await Deno.readTextFile(patternsPath);
      const serializedPatterns = JSON.parse(patternsData);

      for (const [key, pattern] of serializedPatterns) {
        this.patterns.set(key, {
          ...pattern,
          lastUsed: new Date(pattern.lastUsed),
        });
      }

      this.logger.info("Loaded pattern cache", { patternCount: this.patterns.size });
    } catch (error) {
      this.logger.warn("Failed to load pattern cache", { error: String(error) });
    }
  }

  async tryFastPath(context: PlanningContext): Promise<any | null> {
    await this.loadPatterns();

    // Create context hash for exact matching
    const contextHash = this.hashContext(context);

    // Check for exact matches
    if (this.patterns.has(contextHash)) {
      const pattern = this.patterns.get(contextHash)!;
      pattern.usageCount++;
      pattern.lastUsed = new Date();
      await this.savePatterns();

      this.logger.info("Fast path: exact pattern match", { pattern: pattern.pattern });
      return pattern.solution;
    }

    // Check for similar patterns (simple similarity for now)
    const similar = this.findSimilarPatterns(context);
    if (similar && similar.confidence > 0.85) {
      similar.usageCount++;
      similar.lastUsed = new Date();
      await this.savePatterns();

      this.logger.info("Fast path: similar pattern match", {
        pattern: similar.pattern,
        confidence: similar.confidence,
      });
      return this.adaptSolution(similar.solution, context);
    }

    return null; // Need expensive reasoning
  }

  async cachePattern(context: PlanningContext, solution: any): Promise<void> {
    const contextHash = this.hashContext(context);
    const pattern = this.createPatternDescription(context);

    this.patterns.set(contextHash, {
      pattern,
      solution,
      confidence: 1.0,
      usageCount: 1,
      lastUsed: new Date(),
    });

    await this.savePatterns();
    this.logger.info("Cached new pattern", { pattern });
  }

  private hashContext(context: PlanningContext): string {
    // Simple hash based on key characteristics
    const key = `${context.agentType}-${
      context.complexity.toFixed(1)
    }-${context.requiresToolUse}-${context.qualityCritical}`;
    return btoa(key).replace(/[^a-zA-Z0-9]/g, "");
  }

  private createPatternDescription(context: PlanningContext): string {
    const parts = [context.agentType];

    if (context.complexity > 0.7) parts.push("high-complexity");
    else if (context.complexity > 0.4) parts.push("medium-complexity");
    else parts.push("low-complexity");

    if (context.requiresToolUse) parts.push("tool-use");
    if (context.qualityCritical) parts.push("quality-critical");

    return parts.join("-");
  }

  private findSimilarPatterns(context: PlanningContext): PatternSolution | null {
    let bestMatch: PatternSolution | null = null;
    let bestScore = 0;

    for (const pattern of this.patterns.values()) {
      const score = this.calculateSimilarity(context, pattern);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...pattern, confidence: score };
      }
    }

    return bestMatch;
  }

  private calculateSimilarity(context: PlanningContext, pattern: PatternSolution): number {
    // Simple similarity scoring
    let score = 0;
    const description = pattern.pattern;

    if (description.includes(context.agentType)) score += 0.4;

    const complexityDiff = Math.abs(context.complexity - this.extractComplexity(description));
    score += Math.max(0, 0.3 - complexityDiff);

    if (context.requiresToolUse && description.includes("tool-use")) score += 0.2;
    if (context.qualityCritical && description.includes("quality-critical")) score += 0.2;

    return Math.min(1.0, score);
  }

  private extractComplexity(description: string): number {
    if (description.includes("high-complexity")) return 0.8;
    if (description.includes("medium-complexity")) return 0.5;
    if (description.includes("low-complexity")) return 0.2;
    return 0.5;
  }

  private adaptSolution(solution: any, context: PlanningContext): any {
    // Simple adaptation - in real implementation this would be more sophisticated
    return {
      ...solution,
      adaptedFor: context,
      originalSolution: true,
    };
  }

  private async savePatterns(): Promise<void> {
    try {
      const performanceDir = join(this.atlasDir, "performance");
      await Deno.mkdir(performanceDir, { recursive: true });

      const patternsPath = join(performanceDir, "pattern-cache.json");

      // Convert Map to array for serialization
      const serializedPatterns = Array.from(this.patterns.entries()).map(([key, pattern]) => [
        key,
        {
          ...pattern,
          lastUsed: pattern.lastUsed.toISOString(),
        },
      ]);

      await Deno.writeTextFile(patternsPath, JSON.stringify(serializedPatterns, null, 2));
    } catch (error) {
      this.logger.error("Failed to save pattern cache", { error: String(error) });
    }
  }
}
