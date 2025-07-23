/**
 * Clean Test Infrastructure for Atlas Draft System
 *
 * Provides isolated, clean test environments with proper setup and teardown.
 * Follows clean test patterns:
 * - Isolated test databases per test
 * - Proper resource cleanup
 * - No shared state between tests
 * - Real functionality testing (minimal mocking)
 */

import { WorkspaceDraftStore } from "../../src/core/services/workspace-draft-store.ts";
import type { WorkspaceConfig } from "@atlas/config";

export interface CleanTestContext {
  store: WorkspaceDraftStore;
  testId: string;
  cleanup: () => Promise<void>;
}

export interface TestDraftConfig {
  name?: string;
  description?: string;
  sessionId?: string;
  conversationId?: string;
  userId?: string;
  initialConfig?: Partial<WorkspaceConfig>;
}

/**
 * Creates a completely isolated test context with its own KV database
 * Each test gets a unique, temporary database that's automatically cleaned up
 */
export async function createCleanTestContext(testName: string): Promise<CleanTestContext> {
  const testId = `${testName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Create a unique in-memory KV database for this test
  // This ensures complete isolation between tests
  const kv = await Deno.openKv(`:memory:`);

  const store = new WorkspaceDraftStore(kv);

  const cleanup = async () => {
    try {
      // Close the KV connection - since it's in-memory, this fully cleans up
      kv.close();
    } catch (error) {
      console.warn(`Warning: Cleanup failed for test ${testId}:`, error.message);
    }
  };

  return {
    store,
    testId,
    cleanup,
  };
}

/**
 * Test data factory for creating consistent, valid draft configurations
 */
export class DraftTestFactory {
  private counter = 0;

  /**
   * Generate unique identifiers for test isolation
   */
  generateUniqueIds(testId: string) {
    this.counter++;
    return {
      sessionId: `session_${testId}_${this.counter}`,
      conversationId: `conv_${testId}_${this.counter}`,
      userId: `user_${testId}_${this.counter}`,
      draftName: `draft_${testId}_${this.counter}`,
    };
  }

  /**
   * Create a minimal, valid draft configuration
   */
  createMinimalDraft(testId: string, overrides: TestDraftConfig = {}): TestDraftConfig {
    const ids = this.generateUniqueIds(testId);

    return {
      name: overrides.name || ids.draftName,
      description: overrides.description || `Test draft for ${testId}`,
      sessionId: overrides.sessionId || ids.sessionId,
      conversationId: overrides.conversationId || ids.conversationId,
      userId: overrides.userId || ids.userId,
      initialConfig: overrides.initialConfig || {
        version: "1.0",
        workspace: {
          name: overrides.name || ids.draftName,
          description: overrides.description || `Test workspace for ${testId}`,
        },
      },
    };
  }

  /**
   * Create a comprehensive draft with agents, jobs, and signals
   */
  createComprehensiveDraft(testId: string, overrides: TestDraftConfig = {}): TestDraftConfig {
    const ids = this.generateUniqueIds(testId);

    const baseConfig: Partial<WorkspaceConfig> = {
      version: "1.0",
      workspace: {
        name: overrides.name || ids.draftName,
        description: overrides.description || `Comprehensive test workspace for ${testId}`,
      },
      agents: {
        [`agent_${ids.sessionId}`]: {
          type: "llm",
          description: "Test agent with complete configuration",
          config: {
            provider: "anthropic",
            model: "claude-3-5-haiku-latest",
            prompt: "You are a test agent for integration testing.",
            temperature: 0.7,
            max_tokens: 1000,
          },
        },
      },
      jobs: {
        [`job_${ids.sessionId}`]: {
          name: `job_${ids.sessionId}`,
          description: "Test job with proper execution configuration",
          triggers: [{ signal: `signal_${ids.sessionId}` }],
          execution: {
            strategy: "sequential",
            agents: [`agent_${ids.sessionId}`],
          },
        },
      },
      signals: {
        [`signal_${ids.sessionId}`]: {
          description: "Test signal for triggering workflows",
          provider: "system",
          config: {
            enabled: true,
          },
        },
      },
    };

    return {
      name: overrides.name || ids.draftName,
      description: overrides.description || `Comprehensive test draft for ${testId}`,
      sessionId: overrides.sessionId || ids.sessionId,
      conversationId: overrides.conversationId || ids.conversationId,
      userId: overrides.userId || ids.userId,
      initialConfig: overrides.initialConfig || baseConfig,
    };
  }

  /**
   * Create multiple drafts for testing collections and relationships
   */
  createDraftCollection(
    testId: string,
    count: number,
    sharedConversationId?: string,
  ): TestDraftConfig[] {
    const drafts: TestDraftConfig[] = [];
    const conversationId = sharedConversationId || `conv_${testId}_shared`;

    for (let i = 0; i < count; i++) {
      const draft = this.createMinimalDraft(testId, {
        name: `draft_${testId}_${i + 1}`,
        description: `Test draft ${i + 1} for ${testId}`,
        conversationId,
      });
      drafts.push(draft);
    }

    return drafts;
  }
}

/**
 * Assertion helpers for common draft testing scenarios
 */
export class DraftTestAssertions {
  /**
   * Assert that a draft has the expected basic properties
   */
  static assertDraftBasics(draft: any, expectedName: string, expectedDescription: string) {
    if (!draft) throw new Error("Draft is null or undefined");
    if (typeof draft.id !== "string" || draft.id.length === 0) {
      throw new Error("Draft must have a valid string ID");
    }
    if (draft.name !== expectedName) {
      throw new Error(`Expected draft name "${expectedName}", got "${draft.name}"`);
    }
    if (draft.description !== expectedDescription) {
      throw new Error(
        `Expected draft description "${expectedDescription}", got "${draft.description}"`,
      );
    }
    if (!draft.createdAt || !draft.updatedAt) {
      throw new Error("Draft must have createdAt and updatedAt timestamps");
    }
  }

  /**
   * Assert that a draft collection has expected count and properties
   */
  static assertDraftCollection(
    drafts: any[],
    expectedCount: number,
    testContext: string,
  ) {
    if (!Array.isArray(drafts)) {
      throw new Error(`Expected drafts to be an array in ${testContext}`);
    }
    if (drafts.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} drafts in ${testContext}, got ${drafts.length}. ` +
          `Draft IDs: ${drafts.map((d) => d?.id || "undefined").join(", ")}`,
      );
    }

    // Ensure all drafts have unique IDs
    const ids = new Set(drafts.map((d) => d.id));
    if (ids.size !== drafts.length) {
      throw new Error(`Duplicate draft IDs found in ${testContext}`);
    }
  }

  /**
   * Assert that drafts are properly sorted by creation time
   */
  static assertDraftsSortedByCreationTime(drafts: any[], descending = true) {
    if (drafts.length <= 1) return;

    for (let i = 1; i < drafts.length; i++) {
      const prev = new Date(drafts[i - 1].createdAt).getTime();
      const curr = new Date(drafts[i].createdAt).getTime();

      const isProperOrder = descending ? prev >= curr : prev <= curr;
      if (!isProperOrder) {
        const order = descending ? "descending" : "ascending";
        throw new Error(
          `Drafts are not sorted in ${order} order by creation time. ` +
            `Position ${i - 1}: ${drafts[i - 1].createdAt}, Position ${i}: ${drafts[i].createdAt}`,
        );
      }
    }
  }
}

/**
 * Test execution wrapper that ensures proper cleanup
 */
export async function runCleanTest<T>(
  testName: string,
  testFn: (ctx: CleanTestContext, factory: DraftTestFactory) => Promise<T>,
): Promise<T> {
  const ctx = await createCleanTestContext(testName);
  const factory = new DraftTestFactory();

  try {
    return await testFn(ctx, factory);
  } finally {
    await ctx.cleanup();
  }
}

/**
 * Performance and timing utilities for tests
 */
export class TestTimer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  elapsed(): number {
    return Date.now() - this.startTime;
  }

  reset(): void {
    this.startTime = Date.now();
  }

  assertMaxDuration(maxMs: number, operation: string): void {
    const elapsed = this.elapsed();
    if (elapsed > maxMs) {
      throw new Error(`${operation} took ${elapsed}ms, exceeding maximum of ${maxMs}ms`);
    }
  }
}

/**
 * Test scoring and quality metrics
 */
export interface TestQualityScore {
  isolation: number; // 0-10: Test isolation quality
  cleanup: number; // 0-10: Resource cleanup quality
  coverage: number; // 0-10: Functionality coverage
  reliability: number; // 0-10: Test reliability/stability
  performance: number; // 0-10: Test performance
  overall: number; // 0-10: Overall test quality
}

export function calculateTestQuality(
  testName: string,
  isolated: boolean,
  cleanupComplete: boolean,
  functionalityTested: number, // percentage 0-100
  passRate: number, // percentage 0-100
  avgDuration: number, // milliseconds
): TestQualityScore {
  const isolation = isolated ? 10 : 0;
  const cleanup = cleanupComplete ? 10 : 0;
  const coverage = Math.min(10, (functionalityTested / 100) * 10);
  const reliability = Math.min(10, (passRate / 100) * 10);
  const performance = avgDuration < 100
    ? 10
    : avgDuration < 500
    ? 8
    : avgDuration < 1000
    ? 6
    : avgDuration < 2000
    ? 4
    : 2;

  const overall = (isolation + cleanup + coverage + reliability + performance) / 5;

  return {
    isolation,
    cleanup,
    coverage,
    reliability,
    performance,
    overall: Math.round(overall * 10) / 10,
  };
}
