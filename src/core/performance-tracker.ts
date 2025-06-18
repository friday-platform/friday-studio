/**
 * Performance tracking for Atlas supervision and execution
 * Provides detailed timing and performance metrics
 */

export interface PerformanceMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags?: Record<string, string>;
  metadata?: Record<string, any>;
}

export interface PerformanceSpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  children: PerformanceSpan[];
  tags: Record<string, string>;
  metadata: Record<string, any>;
}

export class PerformanceTracker {
  private spans: Map<string, PerformanceSpan> = new Map();
  private activeSpans: Map<string, string> = new Map(); // contextId -> spanId
  private spanIdCounter = 0;

  startSpan(
    name: string,
    contextId?: string,
    tags: Record<string, string> = {},
    metadata: Record<string, any> = {},
  ): string {
    const spanId = `span_${++this.spanIdCounter}`;
    const span: PerformanceSpan = {
      id: spanId,
      name,
      startTime: Date.now(),
      children: [],
      tags,
      metadata,
    };

    this.spans.set(spanId, span);

    if (contextId) {
      this.activeSpans.set(contextId, spanId);
    }

    return spanId;
  }

  endSpan(spanId: string, metadata: Record<string, any> = {}): number {
    const span = this.spans.get(spanId);
    if (!span) {
      console.warn(`Performance span not found: ${spanId}`);
      return 0;
    }

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.metadata = { ...span.metadata, ...metadata };

    return span.duration;
  }

  addChildSpan(parentSpanId: string, childSpanId: string): void {
    const parent = this.spans.get(parentSpanId);
    const child = this.spans.get(childSpanId);

    if (parent && child) {
      parent.children.push(child);
    }
  }

  getSpan(spanId: string): PerformanceSpan | undefined {
    return this.spans.get(spanId);
  }

  // Convenience method for timing operations
  async timeOperation<T>(
    name: string,
    operation: () => Promise<T>,
    tags: Record<string, string> = {},
    metadata: Record<string, any> = {},
  ): Promise<{ result: T; duration: number; spanId: string }> {
    const spanId = this.startSpan(name, undefined, tags, metadata);

    try {
      const result = await operation();
      const duration = this.endSpan(spanId, { success: true });
      return { result, duration, spanId };
    } catch (error) {
      const duration = this.endSpan(spanId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Get performance summary
  getSummary(spanId?: string): PerformanceSummary {
    const span = spanId ? this.spans.get(spanId) : this.getRootSpans()[0];
    if (!span) {
      return {
        totalDuration: 0,
        spans: [],
        metrics: {},
      };
    }

    return {
      totalDuration: span.duration || 0,
      spans: this.flattenSpans(span),
      metrics: this.calculateMetrics(span),
    };
  }

  private getRootSpans(): PerformanceSpan[] {
    const allSpans = Array.from(this.spans.values());
    return allSpans.filter((span) => !allSpans.some((other) => other.children.includes(span)));
  }

  private flattenSpans(span: PerformanceSpan): PerformanceSpan[] {
    const result = [span];
    for (const child of span.children) {
      result.push(...this.flattenSpans(child));
    }
    return result;
  }

  private calculateMetrics(span: PerformanceSpan): Record<string, any> {
    const allSpans = this.flattenSpans(span);

    const byName = allSpans.reduce((acc, s) => {
      if (!acc[s.name]) {
        acc[s.name] = { count: 0, totalDuration: 0, spans: [] };
      }
      acc[s.name].count++;
      acc[s.name].totalDuration += s.duration || 0;
      acc[s.name].spans.push(s);
      return acc;
    }, {} as Record<string, { count: number; totalDuration: number; spans: PerformanceSpan[] }>);

    return {
      spansByName: Object.entries(byName).map(([name, data]) => ({
        name,
        count: data.count,
        totalDuration: data.totalDuration,
        averageDuration: data.totalDuration / data.count,
        percentage: span.duration ? (data.totalDuration / span.duration) * 100 : 0,
      })),
      totalSpans: allSpans.length,
      longestSpan: allSpans.reduce((longest, current) =>
        (current.duration || 0) > (longest.duration || 0) ? current : longest
      ),
      cacheHits: allSpans.filter((s) => s.metadata?.cacheHit).length,
      cacheMisses: allSpans.filter((s) => s.metadata?.cacheMiss).length,
      llmCalls: allSpans.filter((s) => s.tags?.type === "llm").length,
      parallelOperations: allSpans.filter((s) => s.tags?.parallel === "true").length,
    };
  }

  // Clear old spans to prevent memory leaks
  cleanup(olderThanMs: number = 60000): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [spanId, span] of this.spans) {
      if (span.startTime < cutoff) {
        this.spans.delete(spanId);
      }
    }
  }

  // Export spans for analysis
  exportSpans(): PerformanceSpan[] {
    return Array.from(this.spans.values());
  }
}

export interface PerformanceSummary {
  totalDuration: number;
  spans: PerformanceSpan[];
  metrics: Record<string, any>;
}

// Global instance for Atlas performance tracking
export const atlasPerformanceTracker = new PerformanceTracker();

// Utility function for supervision-specific tracking
export function trackSupervisionOperation<T>(
  operationName: string,
  agentId: string,
  operation: () => Promise<T>,
  metadata: Record<string, any> = {},
): Promise<{ result: T; duration: number }> {
  return atlasPerformanceTracker.timeOperation(
    operationName,
    operation,
    {
      type: "supervision",
      agentId,
    },
    metadata,
  );
}
