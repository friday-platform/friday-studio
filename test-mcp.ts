#!/usr/bin/env deno run --allow-all

console.log("🧪 Testing Enhanced Atlas Multi-MCP Integration");
console.log("═══════════════════════════════════════════════");

console.log("\n📁 Creating test files in /tmp...");
await Deno.writeTextFile("/tmp/mcp-test.txt", "Hello from enhanced Atlas MCP test!");
await Deno.writeTextFile("/tmp/readme.md", "# Enhanced MCP Test\n\nTesting both official MCP and Atlas EMCP filesystem capabilities.");
await Deno.writeTextFile("/tmp/security-test.txt", "This file tests security controls");

console.log("✅ Test files created:");
console.log("   - /tmp/mcp-test.txt");
console.log("   - /tmp/readme.md");
console.log("   - /tmp/security-test.txt");

console.log("\n🚀 Triggering enhanced multi-MCP filesystem test...");

try {
  const response = await fetch("http://localhost:8080/test-mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task: "Demonstrate both MCP and EMCP capabilities: 1) Use MCP tools to list and read files in /tmp, 2) Use EMCP tools for pattern matching and metadata analysis, 3) Show security controls in action"
    }),
  });

  if (response.ok) {
    console.log("✅ Enhanced multi-MCP test triggered successfully!");
    console.log("📋 Response status:", response.status);
    
    // The response might be streaming, so just log that it started
    console.log("🤖 Atlas is now processing both MCP and EMCP filesystem operations...");
    console.log("📊 Check the Atlas server logs to see:");
    console.log("   - Official MCP filesystem tools in action");
    console.log("   - Atlas EMCP context provisioning and security controls");
    console.log("   - Multi-MCP integration working together");
  } else {
    console.log("❌ Failed to trigger enhanced MCP test");
    console.log("📋 Response status:", response.status);
    console.log("📋 Response text:", await response.text());
  }
} catch (error) {
  console.log("❌ Error triggering enhanced MCP test:", error.message);
  console.log("💡 Make sure Atlas workspace server is running on http://localhost:8080");
  console.log("   Run: cd examples/workspaces/mcp-test && deno task atlas workspace serve");
}