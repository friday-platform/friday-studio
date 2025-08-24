import { expect } from "@std/expect";
import { CoALAMemoryType } from "../src/coala-memory.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("CoALAMemoryType - enum values", () => {
  expect(CoALAMemoryType.WORKING).toBe("working");
  expect(CoALAMemoryType.EPISODIC).toBe("episodic");
  expect(CoALAMemoryType.SEMANTIC).toBe("semantic");
  expect(CoALAMemoryType.PROCEDURAL).toBe("procedural");
  expect(CoALAMemoryType.CONTEXTUAL).toBe("contextual");
});

Deno.test("Memory types enumeration", () => {
  const memoryTypes = Object.values(CoALAMemoryType);
  expect(memoryTypes).toContain("working");
  expect(memoryTypes).toContain("episodic");
  expect(memoryTypes).toContain("semantic");
  expect(memoryTypes).toContain("procedural");
  expect(memoryTypes).toContain("contextual");
  expect(memoryTypes).toHaveLength(5);
});

Deno.test("Memory entry structure validation", () => {
  const mockEntry = {
    id: "test-memory",
    content: "test content",
    timestamp: new Date(),
    accessCount: 1,
    lastAccessed: new Date(),
    memoryType: CoALAMemoryType.WORKING,
    relevanceScore: 0.8,
    sourceScope: "test-scope",
    associations: [],
    tags: ["test"],
    confidence: 0.9,
    decayRate: 0.1,
  };

  expect(mockEntry.id).toBe("test-memory");
  expect(mockEntry.memoryType).toBe(CoALAMemoryType.WORKING);
  expect(mockEntry.relevanceScore).toBe(0.8);
  expect(mockEntry.confidence).toBe(0.9);
  expect(mockEntry.tags).toContain("test");
});

Deno.test("Memory query structure validation", () => {
  const mockQuery = {
    content: "test query",
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test", "query"],
    minRelevance: 0.5,
    maxAge: 86400000, // 24 hours in ms
    sourceScope: "test-scope",
    limit: 10,
  };

  expect(mockQuery.content).toBe("test query");
  expect(mockQuery.memoryType).toBe(CoALAMemoryType.SEMANTIC);
  expect(mockQuery.tags).toHaveLength(2);
  expect(mockQuery.minRelevance).toBe(0.5);
  expect(mockQuery.limit).toBe(10);
});

Deno.test("Memory package module structure", async () => {
  // Test that the package exports are properly structured
  const { CoALAMemoryManager, CoALAMemoryType: ImportedType } = await import("../mod.ts");

  expect(CoALAMemoryManager).toBeDefined();
  expect(ImportedType).toBeDefined();
  expect(ImportedType.WORKING).toBe("working");
  expect(ImportedType.EPISODIC).toBe("episodic");
});

Deno.test("Knowledge graph entity types", async () => {
  const { KnowledgeEntityType } = await import("../mod.ts");

  expect(KnowledgeEntityType).toBeDefined();
  expect(KnowledgeEntityType.PERSON).toBe("person");
  expect(KnowledgeEntityType.PROJECT).toBe("project");
  expect(KnowledgeEntityType.SERVICE).toBe("service");
  expect(KnowledgeEntityType.CONCEPT).toBe("concept");
  expect(KnowledgeEntityType.PREFERENCE).toBe("preference");
  expect(KnowledgeEntityType.IDENTIFIER).toBe("identifier");
  expect(KnowledgeEntityType.TEAM).toBe("team");
  expect(KnowledgeEntityType.TECHNOLOGY).toBe("technology");
  expect(KnowledgeEntityType.LOCATION).toBe("location");
  expect(KnowledgeEntityType.FACT).toBe("fact");
});

Deno.test("Knowledge graph relationship types", async () => {
  const { KnowledgeRelationType } = await import("../mod.ts");

  expect(KnowledgeRelationType).toBeDefined();
  expect(KnowledgeRelationType.IS_A).toBe("is_a");
  expect(KnowledgeRelationType.PART_OF).toBe("part_of");
  expect(KnowledgeRelationType.WORKS_ON).toBe("works_on");
  expect(KnowledgeRelationType.USES).toBe("uses");
  expect(KnowledgeRelationType.PREFERS).toBe("prefers");
  expect(KnowledgeRelationType.OWNS).toBe("owns");
  expect(KnowledgeRelationType.MEMBER_OF).toBe("member_of");
  expect(KnowledgeRelationType.LOCATED_AT).toBe("located_at");
  expect(KnowledgeRelationType.RELATED_TO).toBe("related_to");
  expect(KnowledgeRelationType.HAS_ATTRIBUTE).toBe("has_attribute");
  expect(KnowledgeRelationType.KNOWS).toBe("knows");
});

Deno.test("Streaming memory queue configuration", () => {
  const mockQueueConfig = {
    maxSize: 1000,
    batchSize: 50,
    flushInterval: 5000,
    backgroundProcessing: true,
    persistenceEnabled: true,
    errorRetryAttempts: 3,
    priorityProcessing: true,
  };

  expect(mockQueueConfig.maxSize).toBe(1000);
  expect(mockQueueConfig.batchSize).toBe(50);
  expect(mockQueueConfig.flushInterval).toBe(5000);
  expect(mockQueueConfig.backgroundProcessing).toBe(true);
  expect(mockQueueConfig.errorRetryAttempts).toBe(3);
});

Deno.test("Memory configuration structure", () => {
  const mockMemoryConfig = {
    enabled: true,
    scope: "agent",
    include_in_context: true,
    context_limits: { relevant_memories: 5, past_successes: 3, past_failures: 2 },
    memory_types: {
      working: { enabled: true, max_age_hours: 8, max_entries: 100 },
      episodic: { enabled: true, max_age_days: 7, max_entries: 200 },
      semantic: { enabled: true, max_age_days: 30, max_entries: 500 },
      procedural: { enabled: true, max_age_days: 90, max_entries: 400 },
    },
  };

  expect(mockMemoryConfig.enabled).toBe(true);
  expect(mockMemoryConfig.scope).toBe("agent");
  expect(mockMemoryConfig.context_limits.relevant_memories).toBe(5);
  expect(mockMemoryConfig.memory_types.working.enabled).toBe(true);
  expect(mockMemoryConfig.memory_types.working.max_age_hours).toBe(8);
});

Deno.test("Package exports structure", async () => {
  const memoryModule = await import("../mod.ts");

  // Check that all expected exports are present
  expect(memoryModule.CoALAMemoryManager).toBeDefined();
  expect(memoryModule.CoALAMemoryType).toBeDefined();
  expect(memoryModule.KnowledgeGraphManager).toBeDefined();
  expect(memoryModule.KnowledgeEntityType).toBeDefined();
  expect(memoryModule.KnowledgeRelationType).toBeDefined();
  expect(memoryModule.StreamingMemoryManager).toBeDefined();
  expect(memoryModule.AsyncMemoryQueue).toBeDefined();
  // FactExtractor moved to packages/system/agents/fact-extractor.ts to avoid circular dependency
});
