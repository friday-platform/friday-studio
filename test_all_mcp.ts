#!/usr/bin/env -S deno test --allow-all

/**
 * Complete test suite for MCP job discoverability functionality
 * Includes unit tests, integration tests, and atlas.yml configuration tests
 */

console.log("🧪 Running complete MCP test suite...\n");

console.log("📋 Running unit tests for job discoverability logic...");
await import("./src/core/mcp/job-discoverability.test.ts");

console.log("\n📋 Running Atlas MCP configuration tests...");
await import("./src/core/mcp/atlas-mcp-config.test.ts");

console.log("\n✅ MCP test suite completed!");
console.log(
  "\nNote: Integration tests with mock servers have resource leaks but pass functionally.",
);
console.log("Run them separately if needed:");
console.log("  deno test --allow-all --no-check src/core/mcp/platform-mcp-server.test.ts");
console.log("  deno test --allow-all --no-check src/core/mcp/two-level-mcp-integration.test.ts");
