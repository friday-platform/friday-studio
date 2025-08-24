/**
 * Supervision caching system for Atlas
 * Caches LLM analysis and validation decisions to reduce supervision overhead
 */

import { createHash } from "node:crypto";

// Cache entry types
export interface SupervisionCacheEntry {
  // Cache metadata
  key: string;
  timestamp: number;
  hitCount: number;

  // Analysis results
  analysis?: AgentAnalysisResult;
  validation?: OutputValidationResult;
  sessionEvaluation?: SessionEvaluationResult;

  // Context for cache validity
  agentId?: string;
  agentType?: string;
  inputPattern?: string;
  supervisionLevel?: SupervisionLevel;

  // Cache control
  ttl?: number; // Time to live in ms
  maxAge?: number; // Max age in ms
}

export interface AgentAnalysisResult {
  riskLevel: "low" | "medium" | "high";
  requiredIsolation: "minimal" | "standard" | "strict";
  preExecutionChecks: string[];
  estimatedDuration: number;
  analysis: string;
  confidence: number;
}

export interface OutputValidationResult {
  isValid: boolean;
  riskScore: number;
  findings: Array<{ type: string; severity: "low" | "medium" | "high"; description: string }>;
  recommendations: string[];
  confidence: number;
}

export interface SessionEvaluationResult {
  shouldContinue: boolean;
  completionReason?: string;
  nextActions: string[];
  confidence: number;
}

export enum SupervisionLevel {
  MINIMAL = "minimal",
  STANDARD = "standard",
  PARANOID = "paranoid",
}

// Cache key generation
export interface CacheKeyContext {
  agentId: string;
  agentType: string;
  inputHash: string;
  supervisionLevel: SupervisionLevel;
  sessionContext?: { signal: string; agentSequence: number; previousOutputHash?: string };
}

// Cache adapter interface
export interface SupervisionCacheAdapter {
  name: string;

  // Basic operations
  get(key: string): Promise<SupervisionCacheEntry | null>;
  set(key: string, entry: SupervisionCacheEntry): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;

  // Batch operations
  getMultiple(keys: string[]): Promise<Map<string, SupervisionCacheEntry>>;
  setMultiple(entries: Map<string, SupervisionCacheEntry>): Promise<void>;

  // Cache management
  size(): Promise<number>;
  keys(): Promise<string[]>;
  cleanup(): Promise<number>; // Returns number of entries cleaned

  // Statistics
  getStats(): Promise<CacheStats>;
}

export interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  averageAge: number;
  memoryUsage?: number;
}

// Main supervision cache
export class SupervisionCache {
  private adapter: SupervisionCacheAdapter;
  private stats: CacheStats;
  private defaultTtl: number;
  private maxEntries: number;

  constructor(
    adapter: SupervisionCacheAdapter,
    options: {
      defaultTtl?: number; // 1 hour default
      maxEntries?: number; // 10k default
    } = {},
  ) {
    this.adapter = adapter;
    this.defaultTtl = options.defaultTtl || 60 * 60 * 1000;
    this.maxEntries = options.maxEntries || 10000;
    this.stats = { totalEntries: 0, totalHits: 0, totalMisses: 0, hitRate: 0, averageAge: 0 };
  }

  // Generate cache keys
  generateAnalysisKey(context: CacheKeyContext): string {
    const data = {
      type: "analysis",
      agentId: context.agentId,
      agentType: context.agentType,
      inputHash: context.inputHash,
      supervisionLevel: context.supervisionLevel,
      sessionContext: context.sessionContext,
    };
    return this.hashObject(data);
  }

  generateValidationKey(context: CacheKeyContext, outputHash: string): string {
    const data = {
      type: "validation",
      agentId: context.agentId,
      outputHash,
      supervisionLevel: context.supervisionLevel,
    };
    return this.hashObject(data);
  }

  generateSessionEvaluationKey(
    sessionId: string,
    agentSequence: number,
    outputHash: string,
  ): string {
    const data = { type: "session_eval", sessionId, agentSequence, outputHash };
    return this.hashObject(data);
  }

  // Cache operations
  async getAnalysis(context: CacheKeyContext): Promise<AgentAnalysisResult | null> {
    const key = this.generateAnalysisKey(context);
    const entry = await this.get(key);
    return entry?.analysis || null;
  }

  async setAnalysis(
    context: CacheKeyContext,
    analysis: AgentAnalysisResult,
    ttl?: number,
  ): Promise<void> {
    const key = this.generateAnalysisKey(context);
    await this.set(key, {
      key,
      timestamp: Date.now(),
      hitCount: 0,
      analysis,
      agentId: context.agentId,
      agentType: context.agentType,
      inputPattern: context.inputHash,
      supervisionLevel: context.supervisionLevel,
      ttl: ttl || this.defaultTtl,
    });
  }

  async getValidation(
    context: CacheKeyContext,
    outputHash: string,
  ): Promise<OutputValidationResult | null> {
    const key = this.generateValidationKey(context, outputHash);
    const entry = await this.get(key);
    return entry?.validation || null;
  }

  async setValidation(
    context: CacheKeyContext,
    outputHash: string,
    validation: OutputValidationResult,
    ttl?: number,
  ): Promise<void> {
    const key = this.generateValidationKey(context, outputHash);
    await this.set(key, {
      key,
      timestamp: Date.now(),
      hitCount: 0,
      validation,
      agentId: context.agentId,
      agentType: context.agentType,
      supervisionLevel: context.supervisionLevel,
      ttl: ttl || this.defaultTtl,
    });
  }

  async getSessionEvaluation(
    sessionId: string,
    agentSequence: number,
    outputHash: string,
  ): Promise<SessionEvaluationResult | null> {
    const key = this.generateSessionEvaluationKey(sessionId, agentSequence, outputHash);
    const entry = await this.get(key);
    return entry?.sessionEvaluation || null;
  }

  async setSessionEvaluation(
    sessionId: string,
    agentSequence: number,
    outputHash: string,
    evaluation: SessionEvaluationResult,
    ttl?: number,
  ): Promise<void> {
    const key = this.generateSessionEvaluationKey(sessionId, agentSequence, outputHash);
    await this.set(key, {
      key,
      timestamp: Date.now(),
      hitCount: 0,
      sessionEvaluation: evaluation,
      ttl: ttl || this.defaultTtl,
    });
  }

  // Internal operations
  private async get(key: string): Promise<SupervisionCacheEntry | null> {
    try {
      const entry = await this.adapter.get(key);
      if (!entry) {
        this.stats.totalMisses++;
        return null;
      }

      // Check expiration
      if (this.isExpired(entry)) {
        await this.adapter.delete(key);
        this.stats.totalMisses++;
        return null;
      }

      // Update hit count and stats
      entry.hitCount++;
      await this.adapter.set(key, entry);
      this.stats.totalHits++;

      return entry;
    } catch (error) {
      console.error(`Supervision cache get error for key ${key}:`, error);
      this.stats.totalMisses++;
      return null;
    }
  }

  private async set(key: string, entry: SupervisionCacheEntry): Promise<void> {
    try {
      // Check cache size limits
      const currentSize = await this.adapter.size();
      if (currentSize >= this.maxEntries) {
        await this.evictOldest();
      }

      await this.adapter.set(key, entry);
      this.stats.totalEntries++;
    } catch (error) {
      console.error(`Supervision cache set error for key ${key}:`, error);
    }
  }

  // Cache management
  private isExpired(entry: SupervisionCacheEntry): boolean {
    if (!entry.ttl) return false;
    return Date.now() - entry.timestamp > entry.ttl;
  }

  private async evictOldest(): Promise<void> {
    // Simple LRU eviction - remove 10% of oldest entries
    const keys = await this.adapter.keys();
    const entries = await this.adapter.getMultiple(keys);

    const sortedEntries = Array.from(entries.entries()).sort(
      ([, a], [, b]) => a.timestamp - b.timestamp,
    );

    const toEvict = Math.ceil(sortedEntries.length * 0.1);
    for (let i = 0; i < toEvict; i++) {
      await this.adapter.delete(sortedEntries[i][0]);
    }
  }

  // Utilities
  private hashObject(obj: any): string {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    return createHash("sha256").update(str).digest("hex").substring(0, 16);
  }

  async getStats(): Promise<CacheStats> {
    const adapterStats = await this.adapter.getStats();
    this.stats.hitRate = this.stats.totalHits / (this.stats.totalHits + this.stats.totalMisses);
    return { ...this.stats, ...adapterStats };
  }

  async cleanup(): Promise<number> {
    return await this.adapter.cleanup();
  }

  async clear(): Promise<void> {
    await this.adapter.clear();
    this.stats = { totalEntries: 0, totalHits: 0, totalMisses: 0, hitRate: 0, averageAge: 0 };
  }
}
