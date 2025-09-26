import { InMemoryStorageAdapter } from "@atlas/storage";
import { expect } from "@std/expect";
import type { ICoALAMemoryStorageAdapter } from "../../../src/types/core.ts";
import type { IMemoryScope } from "../src/coala-memory.ts";
import { CoALAMemoryManager } from "../src/coala-memory.ts";
import type { MemoryType } from "../src/mecmf-interfaces.ts";
import { MockAtlasScope } from "./mocks/storage.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Helper to create memory manager with immediate commits for tests
function createTestMemoryManager(
  scope: IMemoryScope,
  adapter: ICoALAMemoryStorageAdapter,
  enableCognitiveLoop = false,
) {
  return new CoALAMemoryManager(
    scope,
    adapter,
    enableCognitiveLoop,
    { commitDebounceDelay: 0 }, // Immediate commits for tests
  );
}

Deno.test("Integration - memory operations with different types", async () => {
  const scope = new MockAtlasScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);

  // Store different types of memories
  const complexMemories: { key: string; content: string; type: MemoryType; tags: string[] }[] = [
    {
      key: "working-memory",
      content: JSON.stringify({ task: "debug issue", progress: 0.5 }),
      type: "working",
      tags: ["debugging", "current"],
    },
    {
      key: "episodic-memory",
      content: JSON.stringify({ event: "deployed feature X", outcome: "success" }),
      type: "episodic",
      tags: ["deployment", "success"],
    },
    {
      key: "semantic-memory",
      content: JSON.stringify({ concept: "React hooks", description: "state management" }),
      type: "semantic",
      tags: ["knowledge", "react"],
    },
    {
      key: "procedural-memory",
      content: JSON.stringify({ procedure: "code review", steps: ["check tests", "review logic"] }),
      type: "procedural",
      tags: ["process", "review"],
    },
  ];

  // Store all memories
  for (const mem of complexMemories) {
    memory.rememberWithMetadata(mem.key, mem.content, {
      memoryType: mem.type,
      tags: mem.tags,
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.05,
    });
  }

  // Query memories by type
  const workingMemories = memory.getMemoriesByType("working");
  const episodicMemories = memory.getMemoriesByType("episodic");
  const semanticMemories = memory.getMemoriesByType("semantic");
  const proceduralMemories = memory.getMemoriesByType("procedural");

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
  expect(taggedMemories[0]?.tags).toContain("debugging");

  // Cleanup
  await memory.dispose();
});
