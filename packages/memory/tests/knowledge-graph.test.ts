import { expect } from "@std/expect";
import {
  KnowledgeEntity,
  KnowledgeEntityType,
  KnowledgeFact,
  KnowledgeGraphManager,
  KnowledgeRelationship,
  KnowledgeRelationType,
} from "../src/knowledge-graph.ts";
import { MockKnowledgeGraphStorageAdapter } from "./mocks/storage.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("KnowledgeGraphManager - entity operations", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store an entity directly via adapter
  await adapter.storeEntity({
    id: "test-entity",
    name: "Test Entity",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: { description: "A test entity" },
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  // Retrieve the entity
  const entity = await adapter.getEntity("test-entity");
  expect(entity).toBeDefined();
  expect(entity!.name).toBe("Test Entity");
  expect(entity!.type).toBe(KnowledgeEntityType.CONCEPT);
});

Deno.test("KnowledgeGraphManager - relationship operations", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store entities first
  await adapter.storeEntity({
    id: "entity1",
    name: "Entity 1",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeEntity({
    id: "entity2",
    name: "Entity 2",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.8,
    source: "test",
    timestamp: new Date(),
  });

  // Store a relationship
  await adapter.storeRelationship({
    id: "test-relationship",
    sourceEntityId: "entity1",
    targetEntityId: "entity2",
    type: KnowledgeRelationType.RELATED_TO,
    workspaceId: "test-workspace",
    attributes: { strength: 0.7 },
    confidence: 0.85,
    source: "test",
    timestamp: new Date(),
  });

  // Retrieve the relationship
  const relationship = await adapter.getRelationship("test-relationship");
  expect(relationship).toBeDefined();
  expect(relationship!.sourceEntityId).toBe("entity1");
  expect(relationship!.targetEntityId).toBe("entity2");
  expect(relationship!.type).toBe(KnowledgeRelationType.RELATED_TO);
});

Deno.test("KnowledgeGraphManager - fact operations", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store a fact
  await adapter.storeFact({
    id: "test-fact",
    statement: "The sky is blue",
    workspaceId: "test-workspace",
    entities: [],
    relationships: [],
    tags: ["color", "sky"],
    confidence: 0.95,
    source: "observation",
    timestamp: new Date(),
    validated: true,
  });

  // Retrieve the fact
  const fact = await adapter.getFact("test-fact");
  expect(fact).toBeDefined();
  expect(fact!.statement).toBe("The sky is blue");
  expect(fact!.tags).toContain("color");
  expect(fact!.tags).toContain("sky");
});

Deno.test("KnowledgeGraphManager - entity queries", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store multiple entities
  await adapter.storeEntity({
    id: "concept1",
    name: "Test Concept",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeEntity({
    id: "person1",
    name: "Test Person",
    type: KnowledgeEntityType.PERSON,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.8,
    source: "test",
    timestamp: new Date(),
  });

  // Query entities by type
  const concepts = await adapter.queryEntities({
    workspaceId: "test-workspace",
    entityTypes: [KnowledgeEntityType.CONCEPT],
  });

  expect(concepts).toHaveLength(1);
  expect(concepts[0].type).toBe(KnowledgeEntityType.CONCEPT);

  // Query entities by name
  const testEntities = await adapter.queryEntities({
    workspaceId: "test-workspace",
    entityNames: ["Test"],
  });

  expect(testEntities).toHaveLength(2);
});

Deno.test("KnowledgeGraphManager - relationship queries", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store entities and relationships
  await adapter.storeEntity({
    id: "entity1",
    name: "Entity 1",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeEntity({
    id: "entity2",
    name: "Entity 2",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.8,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeRelationship({
    id: "rel1",
    sourceEntityId: "entity1",
    targetEntityId: "entity2",
    type: KnowledgeRelationType.RELATED_TO,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.85,
    source: "test",
    timestamp: new Date(),
  });

  // Query relationships by type
  const relationships = await adapter.queryRelationships({
    workspaceId: "test-workspace",
    relationshipTypes: [KnowledgeRelationType.RELATED_TO],
  });

  expect(relationships).toHaveLength(1);
  expect(relationships[0].type).toBe(KnowledgeRelationType.RELATED_TO);

  // Get entity relationships
  const entityRels = await adapter.getEntityRelationships("entity1");
  expect(entityRels).toHaveLength(1);
  expect(entityRels[0].sourceEntityId).toBe("entity1");
});

Deno.test("KnowledgeGraphManager - path finding", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Create a chain: entity1 -> entity2 -> entity3
  await adapter.storeEntity({
    id: "entity1",
    name: "Entity 1",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeEntity({
    id: "entity2",
    name: "Entity 2",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.8,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeEntity({
    id: "entity3",
    name: "Entity 3",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.7,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeRelationship({
    id: "rel1",
    sourceEntityId: "entity1",
    targetEntityId: "entity2",
    type: KnowledgeRelationType.RELATED_TO,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.85,
    source: "test",
    timestamp: new Date(),
  });

  await adapter.storeRelationship({
    id: "rel2",
    sourceEntityId: "entity2",
    targetEntityId: "entity3",
    type: KnowledgeRelationType.RELATED_TO,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.8,
    source: "test",
    timestamp: new Date(),
  });

  // Find paths from entity1 to entity3
  const paths = await adapter.findPaths("entity1", "entity3", 3);
  expect(paths).toHaveLength(1);
  expect(paths[0]).toHaveLength(2); // Two relationships in the path
});

Deno.test("KnowledgeGraphManager - neighbor finding", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Create a star pattern: center connected to 3 others
  await adapter.storeEntity({
    id: "center",
    name: "Center",
    type: KnowledgeEntityType.CONCEPT,
    workspaceId: "test-workspace",
    attributes: {},
    confidence: 0.9,
    source: "test",
    timestamp: new Date(),
  });

  for (let i = 1; i <= 3; i++) {
    await adapter.storeEntity({
      id: `neighbor${i}`,
      name: `Neighbor ${i}`,
      type: KnowledgeEntityType.CONCEPT,
      workspaceId: "test-workspace",
      attributes: {},
      confidence: 0.8,
      source: "test",
      timestamp: new Date(),
    });

    await adapter.storeRelationship({
      id: `rel${i}`,
      sourceEntityId: "center",
      targetEntityId: `neighbor${i}`,
      type: KnowledgeRelationType.RELATED_TO,
      workspaceId: "test-workspace",
      attributes: {},
      confidence: 0.85,
      source: "test",
      timestamp: new Date(),
    });
  }

  // Find neighbors of center with depth 1
  const neighbors = await adapter.getNeighbors("center", 1);
  expect(neighbors).toHaveLength(3);
  expect(neighbors.map((n) => n.name)).toContain("Neighbor 1");
  expect(neighbors.map((n) => n.name)).toContain("Neighbor 2");
  expect(neighbors.map((n) => n.name)).toContain("Neighbor 3");
});

Deno.test("KnowledgeGraphManager - fact queries", async () => {
  const adapter = new MockKnowledgeGraphStorageAdapter();
  const kg = new KnowledgeGraphManager(adapter, "test-workspace");

  // Store facts
  await adapter.storeFact({
    id: "fact1",
    statement: "Water boils at 100°C",
    workspaceId: "test-workspace",
    entities: [],
    relationships: [],
    tags: ["science", "physics"],
    confidence: 0.99,
    source: "textbook",
    timestamp: new Date(),
    validated: true,
  });

  await adapter.storeFact({
    id: "fact2",
    statement: "Paris is the capital of France",
    workspaceId: "test-workspace",
    entities: [],
    relationships: [],
    tags: ["geography", "cities"],
    confidence: 1.0,
    source: "common knowledge",
    timestamp: new Date(),
    validated: true,
  });

  // Query facts by search
  const physicsFacts = await adapter.queryFacts({
    workspaceId: "test-workspace",
    search: "boils",
  });

  expect(physicsFacts).toHaveLength(1);
  expect(physicsFacts[0].statement).toContain("boils");

  // Query facts by confidence
  const highConfidenceFacts = await adapter.queryFacts({
    workspaceId: "test-workspace",
    minConfidence: 0.99,
  });

  expect(highConfidenceFacts).toHaveLength(2);
});
