/**
 * Vector Search Demo
 *
 * Demonstrates the vector search capabilities for EPISODIC, SEMANTIC, and PROCEDURAL memory types.
 */

import { CoALAMemoryManager, CoALAMemoryType } from "../src/core/memory/coala-memory.ts";

// Mock scope for demo
const mockScope = {
  id: "demo-scope-001",
  // Add other required properties as needed
} as any;

async function vectorSearchDemo() {
  console.log("🚀 Vector Search Demo for Atlas Memory System");
  console.log("=".repeat(50));

  // Initialize memory manager with vector search enabled
  const memoryManager = new CoALAMemoryManager(
    mockScope,
    undefined, // Use default storage adapter
    false, // Disable cognitive loop for demo
    {
      // Vector search configuration
      autoIndexOnWrite: true,
      batchSize: 5,
      similarityThreshold: 0.6,
    },
  );

  console.log("\n📝 Storing memories in different types...");

  // Store EPISODIC memories (specific experiences)
  memoryManager.rememberWithMetadata("meeting-001", {
    type: "meeting",
    title: "Sprint Planning Meeting",
    description: "Discussed user authentication features and database schema",
    participants: ["Alice", "Bob", "Charlie"],
    duration: "2 hours",
    outcome: "Decided to implement OAuth2 with PostgreSQL backend",
  }, {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["meeting", "sprint-planning", "authentication", "database"],
    relevanceScore: 0.8,
  });

  memoryManager.rememberWithMetadata("code-review-001", {
    type: "code-review",
    title: "API Security Review",
    description: "Reviewed authentication middleware and rate limiting implementation",
    reviewer: "Alice",
    files: ["auth.ts", "middleware.ts", "rate-limiter.ts"],
    issues: ["Add input validation", "Improve error handling"],
    status: "approved",
  }, {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["code-review", "security", "authentication", "api"],
    relevanceScore: 0.9,
  });

  // Store SEMANTIC memories (general knowledge)
  memoryManager.rememberWithMetadata("auth-concept", {
    concept: "OAuth2 Authentication",
    definition:
      "OAuth2 is an authorization framework that enables applications to obtain limited access to user accounts",
    benefits: ["Secure", "Standardized", "Flexible scopes", "Token-based"],
    use_cases: ["API access", "Third-party login", "Mobile apps", "Microservices"],
    related_concepts: ["JWT", "Authentication", "Authorization", "Security"],
  }, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["oauth2", "authentication", "security", "api", "concept"],
    relevanceScore: 0.95,
  });

  memoryManager.rememberWithMetadata("database-concept", {
    concept: "PostgreSQL Database",
    definition: "PostgreSQL is a powerful, open source object-relational database system",
    features: ["ACID compliance", "Complex queries", "Extensible", "Standards compliant"],
    advantages: ["Reliability", "Performance", "Advanced features", "Community support"],
    use_cases: ["Web applications", "Data warehousing", "Geographic information systems"],
  }, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["postgresql", "database", "sql", "backend", "concept"],
    relevanceScore: 0.85,
  });

  // Store PROCEDURAL memories (how-to knowledge)
  memoryManager.rememberWithMetadata("auth-setup-procedure", {
    title: "Setting up OAuth2 Authentication",
    steps: [
      "Install OAuth2 library (e.g., passport.js)",
      "Configure OAuth2 provider (Google, GitHub, etc.)",
      "Set up environment variables for client credentials",
      "Create authentication routes (/auth/login, /auth/callback)",
      "Implement middleware for protected routes",
      "Add session management and token storage",
      "Test the authentication flow",
    ],
    prerequisites: ["Node.js environment", "Express.js setup", "Provider account"],
    tools: ["passport.js", "express-session", "dotenv"],
    estimated_time: "2-4 hours",
  }, {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["procedure", "oauth2", "authentication", "setup", "tutorial"],
    relevanceScore: 0.9,
  });

  memoryManager.rememberWithMetadata("db-migration-procedure", {
    title: "Database Migration Best Practices",
    steps: [
      "Create migration file with timestamp",
      "Write both up and down migration functions",
      "Test migration on development database",
      "Backup production database before migration",
      "Run migration during low-traffic period",
      "Verify data integrity after migration",
      "Monitor application for any issues",
    ],
    prerequisites: ["Database access", "Migration tool", "Backup strategy"],
    tools: ["Knex.js", "Sequelize", "TypeORM", "pg_dump"],
    warnings: ["Always backup before production migration", "Test rollback procedures"],
  }, {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["procedure", "database", "migration", "best-practices", "postgresql"],
    relevanceScore: 0.85,
  });

  console.log("✅ Stored 6 memories across EPISODIC, SEMANTIC, and PROCEDURAL types");

  // Wait a moment for indexing to complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("\n🔍 Performing vector searches...");

  // Search 1: Authentication-related memories
  console.log("\n1️⃣ Search: 'authentication security implementation'");
  const authResults = await memoryManager.searchMemoriesByVector(
    "authentication security implementation",
    {
      limit: 3,
      minSimilarity: 0.3,
    },
  );

  console.log(`Found ${authResults.length} relevant memories:`);
  authResults.forEach((result, i) => {
    console.log(
      `   ${i + 1}. [${result.memoryType}] ${result.id} (similarity: ${
        result.similarity.toFixed(3)
      })`,
    );
    if (result.content.title) {
      console.log(`      "${result.content.title}"`);
    }
  });

  // Search 2: Database-specific memories
  console.log("\n2️⃣ Search: 'postgresql database setup migration'");
  const dbResults = await memoryManager.searchMemoriesByVector(
    "postgresql database setup migration",
    {
      memoryTypes: [CoALAMemoryType.SEMANTIC, CoALAMemoryType.PROCEDURAL],
      limit: 2,
      minSimilarity: 0.4,
    },
  );

  console.log(`Found ${dbResults.length} relevant memories:`);
  dbResults.forEach((result, i) => {
    console.log(
      `   ${i + 1}. [${result.memoryType}] ${result.id} (similarity: ${
        result.similarity.toFixed(3)
      })`,
    );
    if (result.content.concept || result.content.title) {
      console.log(`      "${result.content.concept || result.content.title}"`);
    }
  });

  // Search 3: Procedural knowledge only
  console.log("\n3️⃣ Search: 'step by step setup tutorial'");
  const procedureResults = await memoryManager.searchMemoriesByVector(
    "step by step setup tutorial",
    {
      memoryTypes: [CoALAMemoryType.PROCEDURAL],
      limit: 5,
      minSimilarity: 0.2,
    },
  );

  console.log(`Found ${procedureResults.length} relevant memories:`);
  procedureResults.forEach((result, i) => {
    console.log(
      `   ${i + 1}. [${result.memoryType}] ${result.id} (similarity: ${
        result.similarity.toFixed(3)
      })`,
    );
    console.log(`      "${result.content.title}"`);
    console.log(`      Steps: ${result.content.steps?.length || 0}`);
  });

  // Display vector search statistics
  console.log("\n📊 Vector Search Statistics:");
  const stats = await memoryManager.getVectorSearchStats();
  if (stats) {
    console.log(`   Total embeddings: ${(stats as any).totalEmbeddings}`);
    console.log(`   Index size: ${((stats as any).indexSize / 1024).toFixed(1)} KB`);
    console.log(`   By type:`, (stats as any).embeddingsByType);
  }

  console.log(
    "\n✨ Demo completed! Vector search is working for EPISODIC, SEMANTIC, and PROCEDURAL memory types.",
  );

  // Cleanup
  memoryManager.dispose();
}

// Run the demo
if (import.meta.main) {
  vectorSearchDemo().catch(console.error);
}
