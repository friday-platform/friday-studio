import { expect } from "@std/expect";
import { CoALAMemoryManager, CoALAMemoryType } from "../src/coala-memory.ts";
import {
  KnowledgeEntityType,
  KnowledgeGraphManager,
  KnowledgeRelationType,
} from "../src/knowledge-graph.ts";
import { InMemoryStorageAdapter } from "@atlas/storage";
import { MockAtlasScope, MockKnowledgeGraphStorageAdapter } from "./mocks/storage.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("Integration - CoALA memory with knowledge graph", async () => {
  const scope = new MockAtlasScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const kgAdapter = new MockKnowledgeGraphStorageAdapter();

  const memory = new CoALAMemoryManager(scope, memoryAdapter, false);
  const kg = new KnowledgeGraphManager(kgAdapter, scope.id);

  // Store a memory that should create knowledge graph entries
  await memory.rememberWithMetadata("integration-test", {
    content: "John works at Acme Corp",
    entities: ["John", "Acme Corp"],
    relationships: [{ from: "John", to: "Acme Corp", type: "works_at" }],
  }, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["entities", "work"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.05,
  });

  // Add corresponding knowledge graph entries
  await kgAdapter.storeEntity({
    id: "john-entity",
    name: "John",
    type: KnowledgeEntityType.PERSON,
    workspaceId: scope.id,
    attributes: { role: "employee" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await kgAdapter.storeEntity({
    id: "acme-entity",
    name: "Acme Corp",
    type: KnowledgeEntityType.PROJECT,
    workspaceId: scope.id,
    attributes: { industry: "technology" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await kgAdapter.storeRelationship({
    id: "works-at-rel",
    sourceEntityId: "john-entity",
    targetEntityId: "acme-entity",
    type: KnowledgeRelationType.WORKS_ON,
    workspaceId: scope.id,
    attributes: { since: "2023-01-01" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  // Verify memory and knowledge graph are connected
  const retrievedMemory = await memory.recall("integration-test");
  expect(retrievedMemory).toBeDefined();

  const entities = await kgAdapter.queryEntities({ workspaceId: scope.id });
  expect(entities).toHaveLength(2);

  const relationships = await kgAdapter.queryRelationships({ workspaceId: scope.id });
  expect(relationships).toHaveLength(1);
});

Deno.test("Integration - memory operations with different types", async () => {
  const scope = new MockAtlasScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = new CoALAMemoryManager(scope, memoryAdapter, false);

  // Store different types of memories
  const complexMemories = [
    {
      key: "working-memory",
      content: { task: "debug issue", progress: 0.5 },
      type: CoALAMemoryType.WORKING,
      tags: ["debugging", "current"],
    },
    {
      key: "episodic-memory",
      content: { event: "deployed feature X", outcome: "success" },
      type: CoALAMemoryType.EPISODIC,
      tags: ["deployment", "success"],
    },
    {
      key: "semantic-memory",
      content: { concept: "React hooks", description: "state management" },
      type: CoALAMemoryType.SEMANTIC,
      tags: ["knowledge", "react"],
    },
    {
      key: "procedural-memory",
      content: { procedure: "code review", steps: ["check tests", "review logic"] },
      type: CoALAMemoryType.PROCEDURAL,
      tags: ["process", "review"],
    },
  ];

  // Store all memories
  for (const mem of complexMemories) {
    await memory.rememberWithMetadata(mem.key, mem.content, {
      memoryType: mem.type,
      tags: mem.tags,
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.05,
    });
  }

  // Query memories by type
  const workingMemories = memory.getMemoriesByType(CoALAMemoryType.WORKING);
  const episodicMemories = memory.getMemoriesByType(CoALAMemoryType.EPISODIC);
  const semanticMemories = memory.getMemoriesByType(CoALAMemoryType.SEMANTIC);
  const proceduralMemories = memory.getMemoriesByType(CoALAMemoryType.PROCEDURAL);

  expect(workingMemories).toHaveLength(1);
  expect(episodicMemories).toHaveLength(1);
  expect(semanticMemories).toHaveLength(1);
  expect(proceduralMemories).toHaveLength(1);

  // Query with filters
  const taggedMemories = memory.queryMemories({
    tags: ["debugging"],
    minRelevance: 0.5,
    limit: 10,
  });

  expect(taggedMemories).toHaveLength(1);
  expect(taggedMemories[0].tags).toContain("debugging");
});

Deno.test("Integration - knowledge graph operations", async () => {
  const scope = new MockAtlasScope();
  const kgAdapter = new MockKnowledgeGraphStorageAdapter();

  // Store entities
  await kgAdapter.storeEntity({
    id: "person1",
    name: "Alice",
    type: KnowledgeEntityType.PERSON,
    workspaceId: scope.id,
    attributes: { role: "engineer" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await kgAdapter.storeEntity({
    id: "project1",
    name: "Atlas",
    type: KnowledgeEntityType.PROJECT,
    workspaceId: scope.id,
    attributes: { status: "active" },
    confidence: 0.95,
    source: "test",
    timestamp: new Date(),
  });

  // Store relationship
  await kgAdapter.storeRelationship({
    id: "rel1",
    sourceEntityId: "person1",
    targetEntityId: "project1",
    type: KnowledgeRelationType.WORKS_ON,
    workspaceId: scope.id,
    attributes: { since: "2024-01-01" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  // Store fact
  await kgAdapter.storeFact({
    id: "fact1",
    statement: "Alice works on Atlas project",
    entities: [],
    relationships: [],
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
    workspaceId: scope.id,
    tags: ["work", "project"],
    validated: true,
  });

  // Query operations
  const entities = await kgAdapter.queryEntities({ workspaceId: scope.id });
  expect(entities).toHaveLength(2);

  const relationships = await kgAdapter.queryRelationships({ workspaceId: scope.id });
  expect(relationships).toHaveLength(1);

  const facts = await kgAdapter.queryFacts({ workspaceId: scope.id });
  expect(facts).toHaveLength(1);

  // Search operations
  const searchResults = await kgAdapter.queryEntities({
    workspaceId: scope.id,
    search: "Alice",
  });
  expect(searchResults).toHaveLength(1);
  expect(searchResults[0].name).toBe("Alice");
});

Deno.test("Integration - memory and knowledge graph together", async () => {
  const scope = new MockAtlasScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const kgAdapter = new MockKnowledgeGraphStorageAdapter();

  const memory = new CoALAMemoryManager(scope, memoryAdapter, false);
  const kg = new KnowledgeGraphManager(kgAdapter, scope.id);

  // Store related information in both systems

  // Memory: Store context about a meeting
  await memory.rememberWithMetadata("meeting-context", {
    meetingId: "meeting123",
    topic: "Project planning",
    attendees: ["Alice", "Bob"],
    decisions: ["Use React for frontend", "Deploy to AWS"],
  }, {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["meeting", "planning"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.02,
  });

  // Knowledge Graph: Store entities and relationships from the meeting
  await kgAdapter.storeEntity({
    id: "alice",
    name: "Alice",
    type: KnowledgeEntityType.PERSON,
    workspaceId: scope.id,
    attributes: { role: "product_manager" },
    confidence: 0.9,
    source: "meeting123",
    timestamp: new Date(),
  });

  await kgAdapter.storeEntity({
    id: "react",
    name: "React",
    type: KnowledgeEntityType.TECHNOLOGY,
    workspaceId: scope.id,
    attributes: { category: "frontend_framework" },
    confidence: 0.95,
    source: "meeting123",
    timestamp: new Date(),
  });

  await kgAdapter.storeRelationship({
    id: "alice-uses-react",
    sourceEntityId: "alice",
    targetEntityId: "react",
    type: KnowledgeRelationType.USES,
    workspaceId: scope.id,
    attributes: { decided_in: "meeting123" },
    confidence: 0.9,
    source: "meeting123",
    timestamp: new Date(),
  });

  // Verify both systems have complementary information
  const meetingMemory = await memory.recall("meeting-context");
  expect(meetingMemory).toBeDefined();
  expect(meetingMemory.attendees).toContain("Alice");
  expect(meetingMemory.decisions).toContain("Use React for frontend");

  const entities = await kgAdapter.queryEntities({ workspaceId: scope.id });
  expect(entities).toHaveLength(2);

  const aliceEntity = entities.find((e) => e.name === "Alice");
  expect(aliceEntity).toBeDefined();
  expect(aliceEntity?.attributes.role).toBe("product_manager");

  const relationships = await kgAdapter.queryRelationships({ workspaceId: scope.id });
  expect(relationships).toHaveLength(1);
  expect(relationships[0].type).toBe(KnowledgeRelationType.USES);
});

Deno.test("Integration - storage adapter functionality", async () => {
  const memoryAdapter = new InMemoryStorageAdapter();
  const kgAdapter = new MockKnowledgeGraphStorageAdapter();

  // Test CoALA memory operations
  const testData = {
    "test-key": { data: "test-value", memoryType: "working" },
    "task1": { task: "debug", memoryType: "working" },
    "task2": { task: "test", memoryType: "working" },
    "concept1": { concept: "React", memoryType: "semantic" },
  };

  await memoryAdapter.commit(testData);
  const allData = await memoryAdapter.load();
  expect(allData["test-key"]).toEqual({ data: "test-value", memoryType: "working" });

  // Test memory type operations
  await memoryAdapter.commitByType("working", { "new-task": { task: "new-debug" } });
  const workingMemories = await memoryAdapter.loadByType("working");
  expect(Object.keys(workingMemories)).toContain("new-task");

  const allTypes = await memoryAdapter.listMemoryTypes();
  expect(allTypes).toContain("working");
  expect(allTypes).toContain("semantic");

  // Test knowledge graph operations
  const testEntity = {
    id: "test-entity",
    name: "Test Entity",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: { test: true },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  };

  await kgAdapter.storeEntity(testEntity);
  const retrievedEntity = await kgAdapter.getEntity("test-entity");
  expect(retrievedEntity).toBeDefined();
  expect(retrievedEntity?.name).toBe("Test Entity");

  // Test cleanup
  await memoryAdapter.clear();
  const clearedData = await memoryAdapter.load();
  expect(Object.keys(clearedData)).toHaveLength(0);

  kgAdapter.clear();
  const clearedEntities = await kgAdapter.queryEntities({ workspaceId: "test-workspace" });
  expect(clearedEntities).toHaveLength(0);
});
