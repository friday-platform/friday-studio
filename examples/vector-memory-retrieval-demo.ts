/**
 * Vector-Based Memory Retrieval Demo
 *
 * Demonstrates the new vector search-based memory retrieval for prompt enhancement.
 * Shows how WORKING memory uses traditional search while EPISODIC, SEMANTIC, and
 * PROCEDURAL memories use vector search for better semantic matching.
 */

import { CoALAMemoryManager, CoALAMemoryType } from "../src/core/memory/coala-memory.ts";

// Mock scope for demo
const mockScope = {
  id: "demo-scope-002",
} as any;

async function vectorMemoryRetrievalDemo() {
  console.log("🔄 Vector-Based Memory Retrieval Demo");
  console.log("=".repeat(50));

  // Initialize memory manager with vector search enabled
  const memoryManager = new CoALAMemoryManager(
    mockScope,
    undefined, // Use default storage adapter
    false, // Disable cognitive loop for demo
    {
      autoIndexOnWrite: true,
      batchSize: 5,
      similarityThreshold: 0.4,
    },
  );

  console.log("\n📝 Storing diverse memories...");

  // Store WORKING memory (should use traditional search)
  memoryManager.rememberWithMetadata("current-task", {
    status: "in-progress",
    task: "Implementing authentication system for user login",
    progress: "Just completed OAuth2 integration, now working on JWT tokens",
    blockers: ["Need to configure rate limiting", "Database schema needs review"],
    next_steps: ["Set up Redis for session storage", "Write unit tests"],
  }, {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["current", "authentication", "oauth2", "jwt", "in-progress"],
    relevanceScore: 1.0,
  });

  memoryManager.rememberWithMetadata("active-session", {
    user: "developer-alice",
    activity: "Code review for security middleware implementation",
    files_reviewed: ["auth.ts", "middleware.ts", "session.ts"],
    comments: "Looking good, just need to add input validation",
  }, {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["session", "code-review", "security", "middleware"],
    relevanceScore: 0.9,
  });

  // Store SEMANTIC memory (vector indexed)
  memoryManager.rememberWithMetadata("jwt-concept", {
    concept: "JSON Web Tokens (JWT)",
    definition: "Compact, URL-safe means of representing claims securely between parties",
    structure: ["Header (algorithm & type)", "Payload (claims)", "Signature (verification)"],
    benefits: ["Stateless", "Scalable", "Cross-domain", "Self-contained"],
    security_considerations: [
      "Use HTTPS",
      "Short expiration",
      "Validate signature",
      "Avoid sensitive data in payload",
    ],
    use_cases: ["API authentication", "Single sign-on", "Information exchange"],
  }, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["jwt", "authentication", "token", "security", "concept"],
    relevanceScore: 0.95,
  });

  memoryManager.rememberWithMetadata("oauth2-flows", {
    concept: "OAuth2 Authorization Flows",
    flows: {
      "authorization_code": "Most secure for web apps with backend",
      "implicit": "For public clients (deprecated)",
      "client_credentials": "For machine-to-machine communication",
      "resource_owner_password": "For trusted applications only",
    },
    security_best_practices: [
      "Always use HTTPS in production",
      "Implement PKCE for mobile apps",
      "Use state parameter to prevent CSRF",
      "Validate redirect URIs strictly",
    ],
    token_types: ["Access token", "Refresh token", "ID token (OpenID Connect)"],
  }, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["oauth2", "authorization", "flows", "security", "pkce"],
    relevanceScore: 0.90,
  });

  // Store PROCEDURAL memory (vector indexed)
  memoryManager.rememberWithMetadata("jwt-implementation-steps", {
    title: "Implementing JWT Authentication",
    overview: "Step-by-step guide for secure JWT implementation",
    steps: [
      "Install JWT library (jsonwebtoken, jose, etc.)",
      "Configure secret key and algorithm (RS256 recommended)",
      "Create token generation endpoint (/auth/login)",
      "Implement token verification middleware",
      "Add token refresh mechanism",
      "Configure token expiration (15min access, 7day refresh)",
      "Add logout endpoint with token blacklisting",
      "Test token validation and error handling",
    ],
    security_checklist: [
      "Use strong secret keys (256-bit minimum)",
      "Implement proper error handling",
      "Add rate limiting to auth endpoints",
      "Log authentication events",
      "Validate all JWT claims",
    ],
    common_mistakes: [
      "Storing sensitive data in JWT payload",
      "Not validating token expiration",
      "Using weak signing algorithms",
      "Missing HTTPS in production",
    ],
  }, {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["procedure", "jwt", "implementation", "security", "authentication"],
    relevanceScore: 0.85,
  });

  // Store EPISODIC memory (vector indexed)
  memoryManager.rememberWithMetadata("auth-bug-incident", {
    incident: "JWT Token Validation Bug",
    date: "2024-06-15",
    description: "Users were able to access protected routes with expired tokens",
    root_cause: "Middleware was not properly checking token expiration",
    impact: "Medium - potential unauthorized access for ~2 hours",
    fix_applied: "Updated middleware to validate exp claim and current timestamp",
    lessons_learned: [
      "Always test token expiration in staging",
      "Add comprehensive auth middleware tests",
      "Monitor authentication failures in production",
    ],
    prevention_measures: [
      "Automated tests for token validation",
      "Security code review checklist",
      "Regular penetration testing",
    ],
  }, {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["incident", "bug", "jwt", "security", "lessons-learned"],
    relevanceScore: 0.80,
  });

  console.log("✅ Stored 5 memories across all types");

  // Wait for vector indexing
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("\n🔍 Testing Vector-Based Memory Retrieval...");

  // Test 1: Query for authentication-related prompt
  console.log(
    "\n1️⃣ Test: Enhanced prompt for 'How should I implement secure user authentication?'",
  );
  const authPrompt = "How should I implement secure user authentication with JWT tokens?";

  const authResults = await memoryManager.enhancePromptWithMemory(authPrompt, {
    includeWorking: true,
    includeEpisodic: true,
    includeSemantic: true,
    includeProcedural: true,
    maxMemories: 6,
    minSimilarity: 0.3,
    contextFormat: "summary",
  });

  console.log(`📊 Found ${authResults.memoriesUsed} relevant memories`);
  console.log(
    `🔤 Processed tokens: ${authResults.processedPrompt.tokens.slice(0, 10).join(", ")}...`,
  );
  console.log(
    `📝 Enhanced prompt length: ${authResults.enhancedPrompt.length} chars (vs ${authPrompt.length} original)`,
  );
  console.log("\n🖊️ Enhanced Prompt Preview:");
  console.log(authResults.enhancedPrompt);

  // Test 2: Query specifically for procedural knowledge
  console.log("\n2️⃣ Test: Getting relevant memories for 'Show me implementation steps'");
  const proceduralResults = await memoryManager.getRelevantMemoriesForPrompt(
    "Show me step by step implementation process for JWT authentication",
    {
      includeWorking: false,
      includeEpisodic: false,
      includeSemantic: false,
      includeProcedural: true,
      limit: 3,
      minSimilarity: 0.4,
    },
  );

  console.log(`📊 Found ${proceduralResults.memories.length} procedural memories`);
  proceduralResults.memories.forEach((memory, i) => {
    console.log(
      `   ${i + 1}. [${memory.memoryType}] ${memory.id} (similarity: ${
        memory.similarity?.toFixed(3) || "N/A"
      })`,
    );
  });

  // Test 3: Test WORKING memory traditional search
  console.log("\n3️⃣ Test: WORKING memory retrieval (should use traditional search)");
  const workingResults = await memoryManager.queryMemoriesEnhanced({
    memoryType: CoALAMemoryType.WORKING,
    content: "authentication task progress",
    limit: 5,
  });

  console.log(`📊 Found ${workingResults.length} working memories`);
  workingResults.forEach((memory, i) => {
    console.log(
      `   ${i + 1}. [${memory.memoryType}] ${memory.id} (relevance: ${
        memory.relevanceScore.toFixed(3)
      })`,
    );
  });

  // Test 4: Test hybrid search (all types)
  console.log("\n4️⃣ Test: Hybrid search across all memory types");
  const hybridResults = await memoryManager.queryMemoriesEnhanced({
    content: "security implementation best practices",
    limit: 8,
  });

  console.log(`📊 Found ${hybridResults.length} memories across all types`);
  const typeGroups = hybridResults.reduce((groups, memory) => {
    groups[memory.memoryType] = (groups[memory.memoryType] || 0) + 1;
    return groups;
  }, {} as Record<string, number>);

  console.log("📈 By memory type:", typeGroups);

  // Test 5: Demonstrate different context formats
  console.log("\n5️⃣ Test: Different context formats");

  const bulletFormat = await memoryManager.enhancePromptWithMemory(
    "What security considerations should I keep in mind?",
    {
      maxMemories: 4,
      contextFormat: "bullets",
    },
  );

  console.log("🔹 Bullet format preview:");
  console.log(bulletFormat.memoryContext);

  // Display vector search statistics
  console.log("\n📊 Vector Search Statistics:");
  const stats = await memoryManager.getVectorSearchStats();
  if (stats) {
    console.log(`   Total embeddings: ${(stats as any).totalEmbeddings}`);
    console.log(`   Index size: ${((stats as any).indexSize / 1024).toFixed(1)} KB`);
    console.log(`   By type:`, (stats as any).embeddingsByType);
  }

  console.log("\n✨ Demo completed!");
  console.log("\n🎯 Key Points:");
  console.log("• WORKING memory uses traditional text search (unchanged)");
  console.log("• EPISODIC, SEMANTIC, PROCEDURAL use vector search for better semantic matching");
  console.log("• No API calls made during retrieval - only local vector operations");
  console.log("• Automatic prompt tokenization improves search relevance");
  console.log("• Hybrid search combines both approaches seamlessly");

  // Cleanup
  memoryManager.dispose();
}

// Run the demo
if (import.meta.main) {
  vectorMemoryRetrievalDemo().catch(console.error);
}
