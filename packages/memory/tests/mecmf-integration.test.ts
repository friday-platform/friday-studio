/**
 * MECMF Integration Test
 *
 * Basic integration test to verify MECMF components work together correctly.
 * This test focuses on core functionality without requiring external dependencies.
 */

import { describe, expect, it } from "vitest";
import { createConversationContext, MECMFConstants, MemoryUtils } from "../src/mecmf.ts";
import { createMemoryClassifier } from "../src/memory-classifier.ts";
import { createTokenBudgetManager } from "../src/token-budget-manager.ts";

describe("MECMF Integration", () => {
  it("MECMF Memory Classification", () => {
    const classifier = createMemoryClassifier();
    const context = createConversationContext("session-1", "workspace-1", {
      currentTask: "testing memory classification",
    });

    // Test working memory classification
    const workingContent = "The current session is analyzing memory patterns right now";
    const workingType = classifier.classifyContent(workingContent, context);
    expect(workingType).toEqual("working");

    // Test procedural memory classification
    const proceduralContent =
      "First, you should configure the system. Then, run the setup command. Finally, verify the installation.";
    const proceduralType = classifier.classifyContent(proceduralContent, context);
    expect(proceduralType).toEqual("procedural");

    // Test semantic memory classification
    const semanticContent =
      "TypeScript is a strongly typed programming language that builds on JavaScript";
    const semanticType = classifier.classifyContent(semanticContent, context);
    expect(semanticType).toEqual("semantic");

    // Test episodic memory classification
    const episodicContent =
      "Yesterday we tried to deploy the application but encountered an error. We learned that the database connection was misconfigured.";
    const episodicType = classifier.classifyContent(episodicContent, context);
    expect(episodicType).toEqual("episodic");
  });

  it("MECMF Token Budget Management", () => {
    const budgetManager = createTokenBudgetManager();

    // Test token calculation
    const availableTokens = budgetManager.calculateAvailableTokens(8000, 1000);
    expect(availableTokens).toEqual(7000);

    // Test token allocation
    const allocation = budgetManager.allocateTokensByType(4000);
    expect(allocation.working_memory).toEqual(1600); // 40%
    expect(allocation.procedural_memory).toEqual(1000); // 25%
    expect(allocation.semantic_memory).toEqual(1000); // 25%
    expect(allocation.episodic_memory).toEqual(400); // 10%

    // Test token estimation
    const testText = "This is a test sentence for token estimation purposes.";
    const estimatedTokens = budgetManager.estimateTokens(testText);
    expect(estimatedTokens).toBeGreaterThan(0);
  });

  it("MECMF Memory Utils", () => {
    // Test memory type detection utilities
    const workingText = "The current status is active and we're processing right now";
    expect(MemoryUtils.isWorkingMemoryContent(workingText)).toBe(true);
    expect(MemoryUtils.suggestMemoryType(workingText)).toEqual("working");

    const proceduralText =
      "How to setup the system: First, install dependencies. Then, configure settings. Finally, start the service.";
    expect(MemoryUtils.isProceduralContent(proceduralText)).toBe(true);
    expect(MemoryUtils.suggestMemoryType(proceduralText)).toEqual("procedural");

    const semanticText =
      "JavaScript is a dynamic programming language. It represents a flexible approach to web development.";
    expect(MemoryUtils.isSemanticContent(semanticText)).toBe(true);
    expect(MemoryUtils.suggestMemoryType(semanticText)).toEqual("semantic");

    const episodicText =
      "Last week we experienced a major outage when the database crashed unexpectedly.";
    expect(MemoryUtils.isEpisodicContent(episodicText)).toBe(true);
    expect(MemoryUtils.suggestMemoryType(episodicText)).toEqual("episodic");

    // Test key term extraction
    const complexText =
      "The artificial intelligence system processes natural language using machine learning algorithms";
    const keyTerms = MemoryUtils.extractKeyTerms(complexText, 3);
    expect(keyTerms.length).toEqual(3);
    // Key terms should include important words, not stop words
    expect(keyTerms.includes("the")).toBe(false);
    expect(keyTerms.includes("and")).toBe(false);
  });

  it("MECMF Constants and Configuration", () => {
    // Test that constants are properly defined
    expect(MECMFConstants.PERFORMANCE_TARGETS).toBeDefined();
    expect(MECMFConstants.DEFAULT_TOKEN_ALLOCATION).toBeDefined();
    expect(MECMFConstants.RESOURCE_THRESHOLDS).toBeDefined();
    expect(MECMFConstants.VECTOR_SEARCH).toBeDefined();

    // Verify performance targets make sense
    expect(MECMFConstants.PERFORMANCE_TARGETS.MEMORY_RETRIEVAL_LATENCY).toEqual(100);
    expect(MECMFConstants.PERFORMANCE_TARGETS.EMBEDDING_GENERATION_TIME).toEqual(30);

    // Verify token allocations sum to 1.0
    const allocations = MECMFConstants.DEFAULT_TOKEN_ALLOCATION;
    const total =
      allocations.WORKING_MEMORY +
      allocations.PROCEDURAL_MEMORY +
      allocations.SEMANTIC_MEMORY +
      allocations.EPISODIC_MEMORY;
    expect(total).toEqual(1.0);

    // Verify vector search configuration
    expect(MECMFConstants.VECTOR_SEARCH.VECTOR_DIMENSION).toEqual(384);
    expect(MECMFConstants.VECTOR_SEARCH.MAX_SEQUENCE_LENGTH).toEqual(512);
  });

  it("MECMF Conversation Context Creation", () => {
    const context = createConversationContext("session-123", "workspace-456", {
      currentTask: "testing context creation",
      recentMessages: ["Hello", "How are you?", "I'm working on a project"],
      activeAgents: ["agent-1", "agent-2"],
    });

    expect(context.sessionId).toEqual("session-123");
    expect(context.workspaceId).toEqual("workspace-456");
    expect(context.currentTask).toEqual("testing context creation");
    expect(context.recentMessages?.length).toEqual(3);
    expect(context.activeAgents?.length).toEqual(2);
  });

  // Note: Full MECMF setup test is skipped as it requires actual embedding model initialization
  // which would be slow and require network access. In production, this would be tested separately.

  it("MECMF Memory Manager Interface", () => {
    // Test that we can create the interface without full initialization
    const classifier = createMemoryClassifier();
    const budgetManager = createTokenBudgetManager();

    // Verify the main components can be instantiated
    expect(classifier).toBeDefined();
    expect(budgetManager).toBeDefined();

    // Test some basic functionality
    const testContent = "This is test content for memory management";
    const tokens = budgetManager.estimateTokens(testContent);
    expect(tokens).toBeGreaterThan(0);

    const context = createConversationContext("test", "test");
    const memoryType = classifier.classifyContent(testContent, context);
    expect(memoryType).toBeDefined();
  });
});
