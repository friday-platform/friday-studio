#!/usr/bin/env deno run --allow-all

console.log("🧪 Testing Atlas MCP Integration");
console.log("═══════════════════════════════");

console.log("\n📁 Creating test files in /tmp...");
await Deno.writeTextFile("/tmp/mcp-test.txt", "Hello from Atlas MCP test!");
await Deno.writeTextFile("/tmp/readme.md", "# MCP Test\n\nThis file was created for testing MCP filesystem operations.");

console.log("✅ Test files created:");
console.log("   - /tmp/mcp-test.txt");
console.log("   - /tmp/readme.md");

console.log("\n🚀 Triggering MCP filesystem test...");

try {
  const response = await fetch("http://localhost:8080/test-mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task: "List the files in /tmp directory and read the contents of mcp-test.txt"
    }),
  });

  if (response.ok) {
    console.log("✅ MCP test triggered successfully!");
    console.log("📋 Response status:", response.status);
    
    // The response might be streaming, so just log that it started
    console.log("🤖 Atlas is now processing the MCP filesystem operations...");
    console.log("📊 Check the Atlas server logs to see the MCP tools in action!");
  } else {
    console.log("❌ Failed to trigger MCP test");
    console.log("📋 Response status:", response.status);
    console.log("📋 Response text:", await response.text());
  }
} catch (error) {
  console.log("❌ Error triggering MCP test:", error.message);
  console.log("💡 Make sure Atlas workspace server is running on http://localhost:8080");
  console.log("   Run: deno task atlas workspace serve");
}