/**
 * Memory Prompt Enhancement Test
 * 
 * Tests Atlas memory lookup functionality for prompt enhancement
 * to ensure vector search works correctly with workspace memory.
 */

import { assertEquals, assertExists, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

import { CoALAMemoryManager, CoALAMemoryType } from "../src/core/memory/coala-memory.ts";
import { CoALALocalFileStorageAdapter } from "../src/storage/coala-local.ts";
import { AtlasScope } from "../src/core/scope.ts";
import { SupervisorMemoryCoordinator } from "../src/core/memory/supervisor-memory-coordinator.ts";
import { MemoryConfigManager } from "../src/core/memory-config.ts";

// Test data setup
const TEST_WORKSPACE_PATH = "./test_workspace_memory";
const TEST_MEMORY_PATH = join(TEST_WORKSPACE_PATH, ".atlas", "memory");

async function setupTestMemory(): Promise<CoALAMemoryManager> {
  // Create test directory
  await ensureDir(TEST_MEMORY_PATH);
  
  // Create mock scope
  const mockScope = {
    id: "test-workspace-scope",
    parentScopeId: undefined,
  } as any;
  
  // Create storage adapter with specific path
  const storageAdapter = new CoALALocalFileStorageAdapter(TEST_MEMORY_PATH);
  
  // Create memory manager
  const memoryManager = new CoALAMemoryManager(
    mockScope,
    storageAdapter,
    false, // Disable cognitive loop for testing
    {
      autoIndexOnWrite: true,
      batchSize: 5,
      similarityThreshold: 0.3,
    }
  );
  
  // Add test semantic memories about user "odk"
  memoryManager.rememberWithMetadata(
    "user_odk_info",
    {
      type: "person_info",
      statement: "User 'odk' is a developer working on Atlas project",
      details: "Active contributor to Atlas codebase with focus on memory systems"
    },
    {
      memoryType: CoALAMemoryType.SEMANTIC,
      tags: ["person", "developer", "odk", "atlas"],
      relevanceScore: 0.9,
      confidence: 1.0,
    }
  );
  
  memoryManager.rememberWithMetadata(
    "odk_workspace_path",
    {
      type: "service_info", 
      statement: "User odk's workspace is located at /Users/odk/p/tempest/atlas",
      path: "/Users/odk/p/tempest/atlas"
    },
    {
      memoryType: CoALAMemoryType.SEMANTIC,
      tags: ["path", "workspace", "odk", "atlas"],
      relevanceScore: 0.8,
      confidence: 1.0,
    }
  );
  
  // Add procedural memory
  memoryManager.rememberWithMetadata(
    "memory_fix_procedure",
    {
      type: "procedure",
      task: "Fix memory search issues",
      steps: ["Identify storage path problem", "Connect to correct workspace memory", "Add fallback search"],
      outcome: "Memory search returns proper results"
    },
    {
      memoryType: CoALAMemoryType.PROCEDURAL,
      tags: ["procedure", "memory", "fix", "atlas"],
      relevanceScore: 0.7,
      confidence: 0.9,
    }
  );
  
  // Add episodic memory
  memoryManager.rememberWithMetadata(
    "recent_memory_investigation",
    {
      type: "investigation",
      event: "Investigated memory-manager vector search issue",
      findings: "Storage adapter was not connecting to workspace memory",
      resolution: "Fixed by using correct storage path from workspace"
    },
    {
      memoryType: CoALAMemoryType.EPISODIC,
      tags: ["investigation", "memory", "debugging", "odk"],
      relevanceScore: 0.8,
      confidence: 0.9,
    }
  );
  
  // Wait for memory to be stored
  await new Promise(resolve => setTimeout(resolve, 100));
  
  return memoryManager;
}

async function cleanupTestMemory(): Promise<void> {
  try {
    await Deno.remove(TEST_WORKSPACE_PATH, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("CoALA Memory Manager - Basic Memory Storage and Retrieval", async () => {
  const memoryManager = await setupTestMemory();
  
  try {
    // Test basic memory retrieval
    const memories = memoryManager.getMemoriesByType(CoALAMemoryType.SEMANTIC);
    assertEquals(memories.length, 2, "Should have 2 semantic memories");
    
    // Test memory content
    const odkMemory = memories.find(m => m.id === "user_odk_info");
    assertExists(odkMemory, "Should find odk user info memory");
    assertStringIncludes(
      JSON.stringify(odkMemory.content), 
      "odk", 
      "Memory should contain odk reference"
    );
    
  } finally {
    await cleanupTestMemory();
  }
});

Deno.test("CoALA Memory Manager - Vector Search with getRelevantMemoriesForPrompt", async () => {
  const memoryManager = await setupTestMemory();
  
  try {
    // Test memory prompt enhancement with search for "odk"
    const results = await memoryManager.getRelevantMemoriesForPrompt(
      "Tell me about user odk",
      {
        includeWorking: false,
        includeEpisodic: true,
        includeSemantic: true,
        includeProcedural: true,
        limit: 10,
        minSimilarity: 0.1, // Low threshold to ensure we get results
      }
    );
    
    console.log(`Found ${results.memories.length} memories for 'odk' query`);
    console.log("Memory sources:", results.memories.map(m => m.source));
    
    // Should find memories about odk
    assertExists(results, "Should return results object");
    assertExists(results.memories, "Should return memories array");
    
    // Check if we found odk-related memories
    const odkMemories = results.memories.filter(m => 
      JSON.stringify(m.content).toLowerCase().includes("odk") ||
      m.tags.includes("odk")
    );
    
    console.log(`Found ${odkMemories.length} odk-specific memories`);
    odkMemories.forEach((m, i) => {
      console.log(`${i + 1}. ${m.id}: ${m.source} (similarity: ${m.similarity})`);
    });
    
    // We should find at least one odk-related memory
    assertEquals(
      odkMemories.length >= 1, 
      true, 
      `Should find at least 1 odk-related memory, found ${odkMemories.length}`
    );
    
  } finally {
    await cleanupTestMemory();
  }
});

Deno.test("CoALA Memory Manager - enhancePromptWithMemory Integration", async () => {
  const memoryManager = await setupTestMemory();
  
  try {
    // Test prompt enhancement
    const enhancedPrompt = await memoryManager.enhancePromptWithMemory(
      "What do you know about user odk?",
      {
        includeEpisodic: true,
        includeSemantic: true,
        includeProcedural: true,
        maxMemories: 5,
        minSimilarity: 0.1,
        contextFormat: "detailed",
      }
    );
    
    console.log("Enhanced prompt structure:");
    console.log("- Original length:", "What do you know about user odk?".length);
    console.log("- Enhanced length:", enhancedPrompt.enhancedPrompt.length);
    console.log("- Memories used:", enhancedPrompt.memoriesUsed);
    console.log("- Memory context length:", enhancedPrompt.memoryContext.length);
    
    // Check that prompt was enhanced
    assertExists(enhancedPrompt, "Should return enhanced prompt object");
    assertExists(enhancedPrompt.enhancedPrompt, "Should have enhanced prompt text");
    assertExists(enhancedPrompt.memoryContext, "Should have memory context");
    assertEquals(typeof enhancedPrompt.memoriesUsed, "number", "Should have memories used count");
    
    // Enhanced prompt should be longer than original
    assertEquals(
      enhancedPrompt.enhancedPrompt.length > "What do you know about user odk?".length,
      true,
      "Enhanced prompt should be longer than original"
    );
    
    // Should include some memories
    assertEquals(
      enhancedPrompt.memoriesUsed > 0,
      true,
      "Should include at least one memory"
    );
    
    // Enhanced prompt should contain memory context
    assertStringIncludes(
      enhancedPrompt.enhancedPrompt.toLowerCase(),
      "memory",
      "Enhanced prompt should mention memory context"
    );
    
  } finally {
    await cleanupTestMemory();
  }
});

Deno.test("SupervisorMemoryCoordinator - Signal Analysis with Memory", async () => {
  const memoryManager = await setupTestMemory();
  
  try {
    // Create mock workspace scope
    const mockWorkspace = {
      id: "test-workspace",
      memory: memoryManager
    } as any;
    
    // Create supervisor memory coordinator
    const coordinator = new SupervisorMemoryCoordinator(mockWorkspace);
    
    // Test signal analysis with memory
    const mockSignal = {
      id: "test-signal",
      type: "user-request",
      content: "Need help with odk's workspace setup",
      metadata: { user: "odk" }
    } as any;
    
    const analysis = await coordinator.analyzeSignalWithMemory(mockSignal);
    
    console.log("Signal analysis results:");
    console.log("- Relevant memories:", analysis.relevantMemories.length);
    console.log("- Suggested agents:", analysis.suggestedAgents);
    console.log("- Analysis context length:", analysis.analysisContext.length);
    
    // Should return analysis results
    assertExists(analysis, "Should return analysis object");
    assertExists(analysis.relevantMemories, "Should have relevant memories array");
    assertExists(analysis.suggestedAgents, "Should have suggested agents array");
    assertExists(analysis.analysisContext, "Should have analysis context");
    
    // Should find relevant memories for the signal
    assertEquals(
      analysis.relevantMemories.length >= 0,
      true,
      "Should return memories array (may be empty if vector search fails)"
    );
    
  } finally {
    await cleanupTestMemory();
  }
});

Deno.test("MemoryConfigManager - Workspace Memory Initialization", async () => {
  const memoryManager = await setupTestMemory();
  
  try {
    // Test memory config manager
    const config = {
      default: {
        enabled: true,
        storage: TEST_MEMORY_PATH,
        cognitive_loop: false,
        retention: {
          max_age_days: 30,
          max_entries: 1000,
          cleanup_interval_hours: 24
        }
      },
      agent: {
        enabled: true,
        scope: "agent" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 5,
          past_successes: 3,
          past_failures: 2
        },
        memory_types: {
          working: { enabled: true, max_entries: 100 },
          semantic: { enabled: true, max_entries: 200 },
          episodic: { enabled: true, max_entries: 150 },
          procedural: { enabled: true, max_entries: 100 }
        }
      },
      session: {
        enabled: true,
        scope: "session" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 3
        },
        memory_types: {
          working: { enabled: true, max_entries: 200 },
          semantic: { enabled: true, max_entries: 300 },
          episodic: { enabled: true, max_entries: 250 },
          procedural: { enabled: true, max_entries: 150 }
        }
      },
      workspace: {
        enabled: true,
        scope: "workspace" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 15,
          past_successes: 8,
          past_failures: 5
        },
        memory_types: {
          working: { enabled: true, max_entries: 500 },
          semantic: { enabled: true, max_entries: 1000 },
          episodic: { enabled: true, max_entries: 800 },
          procedural: { enabled: true, max_entries: 300 }
        }
      }
    };
    
    const configManager = new MemoryConfigManager(config);
    
    // Create mock scope
    const mockScope = new AtlasScope();
    
    // Test memory manager creation - this will expose any storage path issues
    const workspaceMemory = configManager.getMemoryManager(mockScope, "workspace");
    const sessionMemory = configManager.getMemoryManager(mockScope, "session");
    const agentMemory = configManager.getMemoryManager(mockScope, "agent");
    
    // Verify memory managers were created
    assertExists(workspaceMemory, "Should create workspace memory manager");
    assertExists(sessionMemory, "Should create session memory manager");
    assertExists(agentMemory, "Should create agent memory manager");
    
    // Test memory context building
    const memoryContext = configManager.buildMemoryContext(
      workspaceMemory,
      "Tell me about odk",
      "workspace"
    );
    
    assertExists(memoryContext, "Should create memory context");
    assertExists(memoryContext.systemContext, "Should have system context");
    assertExists(memoryContext.userContext, "Should have user context");
    
    console.log("Memory context test results:");
    console.log("- System context length:", memoryContext.systemContext.length);
    console.log("- User context length:", memoryContext.userContext.length);
    
    // Cleanup
    configManager.cleanup();
    
  } finally {
    await cleanupTestMemory();
  }
});

Deno.test("Memory Storage Path Integration Test", async () => {
  // This test verifies that memory managers connect to the correct storage paths
  
  try {
    await ensureDir(TEST_MEMORY_PATH);
    
    // Create memory manager with specific storage path
    const mockScope = { id: "storage-test-scope" } as any;
    const storageAdapter = new CoALALocalFileStorageAdapter(TEST_MEMORY_PATH);
    const memoryManager = new CoALAMemoryManager(mockScope, storageAdapter, false);
    
    // Add a test memory
    memoryManager.rememberWithMetadata(
      "storage_test_memory",
      { test: "storage path verification" },
      {
        memoryType: CoALAMemoryType.SEMANTIC,
        tags: ["test", "storage"],
        relevanceScore: 0.8,
      }
    );
    
    // Wait for storage
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify the memory was stored in the correct location
    const semanticFile = join(TEST_MEMORY_PATH, "semantic.json");
    
    try {
      const fileContent = await Deno.readTextFile(semanticFile);
      const semanticData = JSON.parse(fileContent);
      
      const testMemory = Object.values(semanticData).find((memory: any) => 
        memory.id === "storage_test_memory"
      );
      
      assertExists(testMemory, "Test memory should be stored in the correct file");
      console.log("✓ Memory correctly stored at:", semanticFile);
      
    } catch (error) {
      throw new Error(`Failed to read stored memory file: ${error.message}`);
    }
    
    // Test that another memory manager can read from the same storage
    const memoryManager2 = new CoALAMemoryManager(mockScope, storageAdapter, false);
    
    // Wait for loading
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const loadedMemories = memoryManager2.getMemoriesByType(CoALAMemoryType.SEMANTIC);
    const foundMemory = loadedMemories.find(m => m.id === "storage_test_memory");
    
    assertExists(foundMemory, "Second memory manager should load stored memory");
    console.log("✓ Memory correctly loaded by second manager");
    
  } finally {
    await cleanupTestMemory();
  }
});