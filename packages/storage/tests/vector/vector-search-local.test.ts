// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { VectorSearchLocalStorageAdapter } from "../../src/vector/vector-search-local.ts";
import type { VectorEmbedding } from "../../src/types/vector-search.ts";

// Helper function to create temporary directory for tests
async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_vector_test_" });
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

// Helper function to create test embedding
function createTestEmbedding(
  id: string,
  vector: number[],
  memoryType: string = "semantic",
): VectorEmbedding {
  return {
    id,
    vector,
    metadata: {
      memoryId: `memory-${id}`,
      memoryType,
      content: `Test content for ${id}`,
      timestamp: new Date(),
      sourceScope: "test-scope",
      tags: ["test", memoryType],
    },
  };
}

Deno.test("VectorSearchLocalStorageAdapter - should store and retrieve embeddings", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    const embedding2 = createTestEmbedding("test2", [0, 1, 0]);

    await adapter.upsertEmbeddings([embedding1, embedding2]);

    const retrieved1 = await adapter.getEmbedding("test1");
    const retrieved2 = await adapter.getEmbedding("test2");

    assertExists(retrieved1);
    assertExists(retrieved2);
    assertEquals(retrieved1.id, "test1");
    assertEquals(retrieved2.id, "test2");
    assertEquals(retrieved1.vector, [1, 0, 0]);
    assertEquals(retrieved2.vector, [0, 1, 0]);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should perform similarity search", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    const embedding2 = createTestEmbedding("test2", [0, 1, 0]);
    const embedding3 = createTestEmbedding("test3", [0.9, 0.1, 0]); // Similar to test1

    await adapter.upsertEmbeddings([embedding1, embedding2, embedding3]);

    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      minSimilarity: 0.5,
      limit: 10,
    });

    assertEquals(results.length, 2);
    assertEquals(results[0].id, "test1"); // Should be first (perfect match)
    assertEquals(results[1].id, "test3"); // Should be second (similar)
    assertEquals(results[0].similarity, 1.0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should filter by memory type", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0], "semantic");
    const embedding2 = createTestEmbedding("test2", [1, 0, 0], "episodic");
    const embedding3 = createTestEmbedding("test3", [1, 0, 0], "working");

    await adapter.upsertEmbeddings([embedding1, embedding2, embedding3]);

    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      memoryTypes: ["semantic", "episodic"],
      minSimilarity: 0.5,
    });

    assertEquals(results.length, 2);
    assertEquals(results.some((r) => r.id === "test1"), true);
    assertEquals(results.some((r) => r.id === "test2"), true);
    assertEquals(results.some((r) => r.id === "test3"), false);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should filter by tags", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    embedding1.metadata.tags = ["important", "project"];

    const embedding2 = createTestEmbedding("test2", [1, 0, 0]);
    embedding2.metadata.tags = ["routine", "daily"];

    await adapter.upsertEmbeddings([embedding1, embedding2]);

    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      tags: ["important"],
      minSimilarity: 0.5,
    });

    assertEquals(results.length, 1);
    assertEquals(results[0].id, "test1");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should get embeddings by type", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0], "semantic");
    const embedding2 = createTestEmbedding("test2", [0, 1, 0], "semantic");
    const embedding3 = createTestEmbedding("test3", [0, 0, 1], "episodic");

    await adapter.upsertEmbeddings([embedding1, embedding2, embedding3]);

    const semanticEmbeddings = await adapter.getEmbeddingsByType("semantic");
    const episodicEmbeddings = await adapter.getEmbeddingsByType("episodic");

    assertEquals(semanticEmbeddings.length, 2);
    assertEquals(episodicEmbeddings.length, 1);
    assertEquals(semanticEmbeddings.some((e) => e.id === "test1"), true);
    assertEquals(semanticEmbeddings.some((e) => e.id === "test2"), true);
    assertEquals(episodicEmbeddings[0].id, "test3");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should delete embeddings", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    const embedding2 = createTestEmbedding("test2", [0, 1, 0]);

    await adapter.upsertEmbeddings([embedding1, embedding2]);

    // Verify embeddings exist
    let retrieved1 = await adapter.getEmbedding("test1");
    let retrieved2 = await adapter.getEmbedding("test2");
    assertExists(retrieved1);
    assertExists(retrieved2);

    // Delete one embedding
    await adapter.deleteEmbeddings(["test1"]);

    // Verify deletion
    retrieved1 = await adapter.getEmbedding("test1");
    retrieved2 = await adapter.getEmbedding("test2");
    assertEquals(retrieved1, null);
    assertExists(retrieved2);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should clear all embeddings", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    const embedding2 = createTestEmbedding("test2", [0, 1, 0]);

    await adapter.upsertEmbeddings([embedding1, embedding2]);

    // Verify embeddings exist
    let stats = await adapter.getStats();
    assertEquals(stats.totalEmbeddings, 2);

    // Clear all embeddings
    await adapter.clear();

    // Verify clearing
    stats = await adapter.getStats();
    assertEquals(stats.totalEmbeddings, 0);

    const retrieved1 = await adapter.getEmbedding("test1");
    const retrieved2 = await adapter.getEmbedding("test2");
    assertEquals(retrieved1, null);
    assertEquals(retrieved2, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should provide accurate stats", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0], "semantic");
    const embedding2 = createTestEmbedding("test2", [0, 1, 0], "semantic");
    const embedding3 = createTestEmbedding("test3", [0, 0, 1], "episodic");

    await adapter.upsertEmbeddings([embedding1, embedding2, embedding3]);

    const stats = await adapter.getStats();
    assertEquals(stats.totalEmbeddings, 3);
    assertEquals(stats.embeddingsByType["semantic"], 2);
    assertEquals(stats.embeddingsByType["episodic"], 1);
    assertEquals(stats.indexSize > 0, true);
    assertExists(stats.lastUpdated);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should handle empty search results", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      minSimilarity: 0.5,
    });

    assertEquals(results.length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should respect similarity threshold", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embedding1 = createTestEmbedding("test1", [1, 0, 0]);
    const embedding2 = createTestEmbedding("test2", [0, 1, 0]); // Perpendicular, similarity = 0

    await adapter.upsertEmbeddings([embedding1, embedding2]);

    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      minSimilarity: 0.5, // Should filter out embedding2
    });

    assertEquals(results.length, 1);
    assertEquals(results[0].id, "test1");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("VectorSearchLocalStorageAdapter - should respect search limit", async () => {
  const tempDir = await createTempDir();
  const adapter = new VectorSearchLocalStorageAdapter(tempDir);

  try {
    const embeddings = [];
    for (let i = 0; i < 10; i++) {
      embeddings.push(createTestEmbedding(`test${i}`, [1, 0, 0]));
    }

    await adapter.upsertEmbeddings(embeddings);

    const results = await adapter.search({
      query: "test query",
      vector: [1, 0, 0],
      limit: 3,
      minSimilarity: 0.5,
    });

    assertEquals(results.length, 3);
  } finally {
    await cleanupTempDir(tempDir);
  }
});
