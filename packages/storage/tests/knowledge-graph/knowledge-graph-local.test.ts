// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { KnowledgeGraphLocalStorageAdapter } from "../../src/knowledge-graph/knowledge-graph-local.ts";
import type {
  KnowledgeEntity,
  KnowledgeEntityType,
  KnowledgeFact,
  KnowledgeRelationship,
  KnowledgeRelationType,
} from "../../src/types/core.ts";

// Helper function to create temporary directory for tests
async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_kg_test_" });
  return tempDir;
}

// Helper function to cleanup temporary directory
async function cleanupTempDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

// Helper functions to create test data
function createTestEntity(
  id: string,
  name: string,
  type: KnowledgeEntityType,
  workspaceId: string = "test-workspace",
): KnowledgeEntity {
  return {
    id,
    name,
    type,
    attributes: { description: `Test entity ${name}` },
    confidence: 0.9,
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createTestRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: KnowledgeRelationType,
  workspaceId: string = "test-workspace",
): KnowledgeRelationship {
  return {
    id,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    type,
    attributes: { description: `Test relationship ${type}` },
    confidence: 0.8,
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createTestFact(
  id: string,
  statement: string,
  workspaceId: string = "test-workspace",
): KnowledgeFact {
  return {
    id,
    statement,
    confidence: 0.85,
    tags: ["test", "fact"],
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

Deno.test("KnowledgeGraphLocalStorageAdapter - should store and retrieve entities", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const entity1 = createTestEntity("entity1", "John Doe", "person" as KnowledgeEntityType);
    const entity2 = createTestEntity("entity2", "Acme Corp", "organization" as KnowledgeEntityType);

    await adapter.storeEntity(entity1);
    await adapter.storeEntity(entity2);

    const retrieved1 = await adapter.getEntity("entity1");
    const retrieved2 = await adapter.getEntity("entity2");

    assertExists(retrieved1);
    assertExists(retrieved2);
    assertEquals(retrieved1.name, "John Doe");
    assertEquals(retrieved2.name, "Acme Corp");
    assertEquals(retrieved1.type, "person");
    assertEquals(retrieved2.type, "organization");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should query entities by type", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const person1 = createTestEntity("person1", "John Doe", "person" as KnowledgeEntityType);
    const person2 = createTestEntity("person2", "Jane Smith", "person" as KnowledgeEntityType);
    const org1 = createTestEntity("org1", "Acme Corp", "organization" as KnowledgeEntityType);

    await adapter.storeEntity(person1);
    await adapter.storeEntity(person2);
    await adapter.storeEntity(org1);

    const people = await adapter.queryEntities({ entityTypes: ["person" as KnowledgeEntityType] });

    const orgs = await adapter.queryEntities({
      entityTypes: ["organization" as KnowledgeEntityType],
    });

    assertEquals(people.length, 2);
    assertEquals(orgs.length, 1);
    assertEquals(
      people.some((p) => p.name === "John Doe"),
      true,
    );
    assertEquals(
      people.some((p) => p.name === "Jane Smith"),
      true,
    );
    assertEquals(orgs[0].name, "Acme Corp");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should store and retrieve relationships", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const person = createTestEntity("person1", "John Doe", "person" as KnowledgeEntityType);
    const org = createTestEntity("org1", "Acme Corp", "organization" as KnowledgeEntityType);
    const relationship = createTestRelationship(
      "rel1",
      "person1",
      "org1",
      "works_for" as KnowledgeRelationType,
    );

    await adapter.storeEntity(person);
    await adapter.storeEntity(org);
    await adapter.storeRelationship(relationship);

    const retrieved = await adapter.getRelationship("rel1");
    assertExists(retrieved);
    assertEquals(retrieved.sourceEntityId, "person1");
    assertEquals(retrieved.targetEntityId, "org1");
    assertEquals(retrieved.type, "works_for");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should get entity relationships", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const person = createTestEntity("person1", "John Doe", "person" as KnowledgeEntityType);
    const org1 = createTestEntity("org1", "Acme Corp", "organization" as KnowledgeEntityType);
    const org2 = createTestEntity("org2", "Beta Inc", "organization" as KnowledgeEntityType);

    const rel1 = createTestRelationship(
      "rel1",
      "person1",
      "org1",
      "works_for" as KnowledgeRelationType,
    );
    const rel2 = createTestRelationship(
      "rel2",
      "person1",
      "org2",
      "collaborates_with" as KnowledgeRelationType,
    );

    await adapter.storeEntity(person);
    await adapter.storeEntity(org1);
    await adapter.storeEntity(org2);
    await adapter.storeRelationship(rel1);
    await adapter.storeRelationship(rel2);

    const relationships = await adapter.getEntityRelationships("person1");
    assertEquals(relationships.length, 2);
    assertEquals(
      relationships.some((r) => r.type === "works_for"),
      true,
    );
    assertEquals(
      relationships.some((r) => r.type === "collaborates_with"),
      true,
    );
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should store and retrieve facts", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const fact1 = createTestFact("fact1", "The sky is blue");
    const fact2 = createTestFact("fact2", "Water boils at 100°C");

    await adapter.storeFact(fact1);
    await adapter.storeFact(fact2);

    const retrieved1 = await adapter.getFact("fact1");
    const retrieved2 = await adapter.getFact("fact2");

    assertExists(retrieved1);
    assertExists(retrieved2);
    assertEquals(retrieved1.statement, "The sky is blue");
    assertEquals(retrieved2.statement, "Water boils at 100°C");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should query facts by search term", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const fact1 = createTestFact("fact1", "The sky is blue during the day");
    const fact2 = createTestFact("fact2", "Water boils at 100°C");
    const fact3 = createTestFact("fact3", "The sky appears red at sunset");

    await adapter.storeFact(fact1);
    await adapter.storeFact(fact2);
    await adapter.storeFact(fact3);

    const skyFacts = await adapter.queryFacts({ search: "sky" });

    assertEquals(skyFacts.length, 2);
    assertEquals(
      skyFacts.some((f) => f.statement.includes("blue")),
      true,
    );
    assertEquals(
      skyFacts.some((f) => f.statement.includes("red")),
      true,
    );
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should update entities", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const entity = createTestEntity("entity1", "John Doe", "person" as KnowledgeEntityType);
    await adapter.storeEntity(entity);

    await adapter.updateEntity("entity1", {
      name: "John Smith",
      attributes: { description: "Updated description", age: 30 },
    });

    const updated = await adapter.getEntity("entity1");
    assertExists(updated);
    assertEquals(updated.name, "John Smith");
    assertEquals(updated.attributes.description, "Updated description");
    assertEquals(updated.attributes.age, 30);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should delete entities", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const entity = createTestEntity("entity1", "John Doe", "person" as KnowledgeEntityType);
    await adapter.storeEntity(entity);

    let retrieved = await adapter.getEntity("entity1");
    assertExists(retrieved);

    await adapter.deleteEntity("entity1");

    retrieved = await adapter.getEntity("entity1");
    assertEquals(retrieved, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should delete relationships", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const relationship = createTestRelationship(
      "rel1",
      "person1",
      "org1",
      "works_for" as KnowledgeRelationType,
    );
    await adapter.storeRelationship(relationship);

    let retrieved = await adapter.getRelationship("rel1");
    assertExists(retrieved);

    await adapter.deleteRelationship("rel1");

    retrieved = await adapter.getRelationship("rel1");
    assertEquals(retrieved, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should delete facts", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const fact = createTestFact("fact1", "The sky is blue");
    await adapter.storeFact(fact);

    let retrieved = await adapter.getFact("fact1");
    assertExists(retrieved);

    await adapter.deleteFact("fact1");

    retrieved = await adapter.getFact("fact1");
    assertEquals(retrieved, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should find paths between entities", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    // Create entities: A -> B -> C
    const rel1 = createTestRelationship("rel1", "A", "B", "works_for" as KnowledgeRelationType);
    const rel2 = createTestRelationship("rel2", "B", "C", "part_of" as KnowledgeRelationType);

    await adapter.storeRelationship(rel1);
    await adapter.storeRelationship(rel2);

    const paths = await adapter.findPaths("A", "C", 3);
    assertEquals(paths.length, 1);
    assertEquals(paths[0].length, 2);
    assertEquals(paths[0][0].id, "rel1");
    assertEquals(paths[0][1].id, "rel2");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should get neighbors", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const entityA = createTestEntity("A", "Entity A", "person" as KnowledgeEntityType);
    const entityB = createTestEntity("B", "Entity B", "person" as KnowledgeEntityType);
    const entityC = createTestEntity("C", "Entity C", "organization" as KnowledgeEntityType);

    await adapter.storeEntity(entityA);
    await adapter.storeEntity(entityB);
    await adapter.storeEntity(entityC);

    const rel1 = createTestRelationship("rel1", "A", "B", "works_for" as KnowledgeRelationType);
    const rel2 = createTestRelationship("rel2", "A", "C", "part_of" as KnowledgeRelationType);

    await adapter.storeRelationship(rel1);
    await adapter.storeRelationship(rel2);

    const neighbors = await adapter.getNeighbors("A", 1);
    assertEquals(neighbors.length, 2);
    assertEquals(
      neighbors.some((n) => n.id === "B"),
      true,
    );
    assertEquals(
      neighbors.some((n) => n.id === "C"),
      true,
    );
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should query with confidence threshold", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const highConfidenceEntity = createTestEntity(
      "high",
      "High Confidence",
      "person" as KnowledgeEntityType,
    );
    const lowConfidenceEntity = createTestEntity(
      "low",
      "Low Confidence",
      "person" as KnowledgeEntityType,
    );

    highConfidenceEntity.confidence = 0.9;
    lowConfidenceEntity.confidence = 0.3;

    await adapter.storeEntity(highConfidenceEntity);
    await adapter.storeEntity(lowConfidenceEntity);

    const results = await adapter.queryEntities({ minConfidence: 0.5 });

    assertEquals(results.length, 1);
    assertEquals(results[0].id, "high");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should query with limit", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    for (let i = 0; i < 10; i++) {
      const entity = createTestEntity(`entity${i}`, `Entity ${i}`, "person" as KnowledgeEntityType);
      await adapter.storeEntity(entity);
    }

    const results = await adapter.queryEntities({ limit: 5 });

    assertEquals(results.length, 5);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("KnowledgeGraphLocalStorageAdapter - should handle workspace isolation", async () => {
  const tempDir = await createTempDir();
  const adapter = new KnowledgeGraphLocalStorageAdapter(tempDir);

  try {
    const entity1 = createTestEntity(
      "entity1",
      "Entity 1",
      "person" as KnowledgeEntityType,
      "workspace1",
    );
    const entity2 = createTestEntity(
      "entity2",
      "Entity 2",
      "person" as KnowledgeEntityType,
      "workspace2",
    );

    await adapter.storeEntity(entity1);
    await adapter.storeEntity(entity2);

    const workspace1Results = await adapter.queryEntities({ workspaceId: "workspace1" });

    const workspace2Results = await adapter.queryEntities({ workspaceId: "workspace2" });

    assertEquals(workspace1Results.length, 1);
    assertEquals(workspace2Results.length, 1);
    assertEquals(workspace1Results[0].id, "entity1");
    assertEquals(workspace2Results[0].id, "entity2");
  } finally {
    await cleanupTempDir(tempDir);
  }
});
