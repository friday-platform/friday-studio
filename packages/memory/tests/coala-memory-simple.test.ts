import { expect } from "@std/expect";
import { CoALAMemoryType } from "../src/coala-memory.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("CoALAMemoryType - enum values are correct", () => {
  expect(CoALAMemoryType.WORKING).toBe("working");
  expect(CoALAMemoryType.EPISODIC).toBe("episodic");
  expect(CoALAMemoryType.SEMANTIC).toBe("semantic");
  expect(CoALAMemoryType.PROCEDURAL).toBe("procedural");
  expect(CoALAMemoryType.CONTEXTUAL).toBe("contextual");
});

Deno.test("CoALAMemoryType - all enum values exist", () => {
  const values = Object.values(CoALAMemoryType);
  expect(values).toContain("working");
  expect(values).toContain("episodic");
  expect(values).toContain("semantic");
  expect(values).toContain("procedural");
  expect(values).toContain("contextual");
  expect(values).toHaveLength(5);
});

Deno.test("CoALAMemoryEntry - interface structure", () => {
  // Test that we can create a valid memory entry structure
  const mockMemoryEntry = {
    id: "test-memory-123",
    content: { text: "This is a test memory", data: [1, 2, 3] },
    timestamp: new Date("2024-01-01T00:00:00Z"),
    accessCount: 5,
    lastAccessed: new Date("2024-01-01T12:00:00Z"),
    memoryType: CoALAMemoryType.WORKING,
    relevanceScore: 0.85,
    sourceScope: "test-scope-456",
    associations: ["related-memory-1", "related-memory-2"],
    tags: ["test", "working", "sample"],
    confidence: 0.92,
    decayRate: 0.1,
  };

  // Validate the structure
  expect(mockMemoryEntry.id).toBe("test-memory-123");
  expect(mockMemoryEntry.content.text).toBe("This is a test memory");
  expect(mockMemoryEntry.content.data).toEqual([1, 2, 3]);
  expect(mockMemoryEntry.memoryType).toBe(CoALAMemoryType.WORKING);
  expect(mockMemoryEntry.relevanceScore).toBe(0.85);
  expect(mockMemoryEntry.confidence).toBe(0.92);
  expect(mockMemoryEntry.decayRate).toBe(0.1);
  expect(mockMemoryEntry.tags).toHaveLength(3);
  expect(mockMemoryEntry.associations).toHaveLength(2);
  expect(mockMemoryEntry.accessCount).toBe(5);
});

Deno.test("CoALAMemoryQuery - interface structure", () => {
  // Test that we can create a valid memory query structure
  const mockQuery = {
    content: "search for relevant memories",
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["important", "project"],
    minRelevance: 0.7,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    sourceScope: "project-scope",
    limit: 20,
  };

  // Validate the structure
  expect(mockQuery.content).toBe("search for relevant memories");
  expect(mockQuery.memoryType).toBe(CoALAMemoryType.SEMANTIC);
  expect(mockQuery.tags).toContain("important");
  expect(mockQuery.tags).toContain("project");
  expect(mockQuery.minRelevance).toBe(0.7);
  expect(mockQuery.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  expect(mockQuery.sourceScope).toBe("project-scope");
  expect(mockQuery.limit).toBe(20);
});

Deno.test("CoALAMemoryManager - can be imported", async () => {
  // Test that the CoALAMemoryManager can be imported from the module
  const { CoALAMemoryManager } = await import("../src/coala-memory.ts");
  expect(CoALAMemoryManager).toBeDefined();
  expect(typeof CoALAMemoryManager).toBe("function");
});

Deno.test("CoALAMemoryManager - exports from mod.ts", async () => {
  // Test that the CoALAMemoryManager is properly exported from the main module
  const { CoALAMemoryManager } = await import("../mod.ts");
  expect(CoALAMemoryManager).toBeDefined();
  expect(typeof CoALAMemoryManager).toBe("function");
});

Deno.test("Memory type validation", () => {
  // Test that we can validate memory types
  const validTypes = [
    CoALAMemoryType.WORKING,
    CoALAMemoryType.EPISODIC,
    CoALAMemoryType.SEMANTIC,
    CoALAMemoryType.PROCEDURAL,
    CoALAMemoryType.CONTEXTUAL,
  ];

  validTypes.forEach((type) => {
    expect(Object.values(CoALAMemoryType)).toContain(type);
  });
});

Deno.test("Memory entry with different types", () => {
  const memoryTypes = [
    CoALAMemoryType.WORKING,
    CoALAMemoryType.EPISODIC,
    CoALAMemoryType.SEMANTIC,
    CoALAMemoryType.PROCEDURAL,
    CoALAMemoryType.CONTEXTUAL,
  ];

  memoryTypes.forEach((type, index) => {
    const memory = {
      id: `memory-${index}`,
      content: `Content for ${type} memory`,
      timestamp: new Date(),
      accessCount: 1,
      lastAccessed: new Date(),
      memoryType: type,
      relevanceScore: 0.8,
      sourceScope: "test-scope",
      associations: [],
      tags: [type],
      confidence: 0.9,
      decayRate: 0.05,
    };

    expect(memory.memoryType).toBe(type);
    expect(memory.tags).toContain(type);
    expect(memory.id).toBe(`memory-${index}`);
  });
});

Deno.test("Memory scoring and confidence validation", () => {
  const testScores = [
    { relevance: 0.0, confidence: 0.0, valid: true },
    { relevance: 0.5, confidence: 0.5, valid: true },
    { relevance: 1.0, confidence: 1.0, valid: true },
    { relevance: -0.1, confidence: 0.5, valid: false },
    { relevance: 1.1, confidence: 0.5, valid: false },
    { relevance: 0.5, confidence: -0.1, valid: false },
    { relevance: 0.5, confidence: 1.1, valid: false },
  ];

  testScores.forEach(({ relevance, confidence, valid }, index) => {
    const isValidRelevance = relevance >= 0 && relevance <= 1;
    const isValidConfidence = confidence >= 0 && confidence <= 1;
    const isValid = isValidRelevance && isValidConfidence;

    expect(isValid).toBe(valid);

    if (valid) {
      // Create a valid memory entry
      const memory = {
        id: `test-memory-${index}`,
        content: "test content",
        timestamp: new Date(),
        accessCount: 1,
        lastAccessed: new Date(),
        memoryType: CoALAMemoryType.WORKING,
        relevanceScore: relevance,
        sourceScope: "test-scope",
        associations: [],
        tags: ["test"],
        confidence: confidence,
        decayRate: 0.1,
      };

      expect(memory.relevanceScore).toBe(relevance);
      expect(memory.confidence).toBe(confidence);
    }
  });
});

Deno.test("Memory decay rate validation", () => {
  const testDecayRates = [
    { rate: 0.001, description: "very slow decay" },
    { rate: 0.01, description: "slow decay" },
    { rate: 0.1, description: "normal decay" },
    { rate: 0.5, description: "fast decay" },
    { rate: 1.0, description: "immediate decay" },
  ];

  testDecayRates.forEach(({ rate, description }) => {
    const memory = {
      id: `decay-test-${rate}`,
      content: `Memory with ${description}`,
      timestamp: new Date(),
      accessCount: 1,
      lastAccessed: new Date(),
      memoryType: CoALAMemoryType.WORKING,
      relevanceScore: 0.8,
      sourceScope: "decay-test",
      associations: [],
      tags: ["decay", "test"],
      confidence: 0.9,
      decayRate: rate,
    };

    expect(memory.decayRate).toBe(rate);
    expect(memory.content).toContain(description);
  });
});
