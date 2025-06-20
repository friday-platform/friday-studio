#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options

/**
 * Simple demonstration that MCP integration is working
 * This proves the web-analysis workspace can call Playwright MCP tools
 */

import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";

// Set API key
Deno.env.set(
  "ANTHROPIC_API_KEY",
  "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",
);

async function demonstrateMCPIntegration() {
  console.log("🕷️  Demonstrating Playwright MCP Integration");
  console.log("=".repeat(50));

  try {
    // Exact same configuration as workspace.yml
    const playwrightMCPConfig = {
      id: "playwright",
      transport: {
        type: "stdio" as const,
        command: "npx",
        args: ["@playwright/mcp@latest", "--headless", "--isolated"],
      },
      tools: {
        allowed: [
          "browser_navigate",
          "browser_snapshot",
          "browser_take_screenshot",
          "browser_click",
          "browser_type",
          "browser_wait_for",
          "browser_network_requests",
          "browser_console_messages",
          "browser_pdf_save",
        ],
      },
      timeout_ms: 30000,
    };

    console.log("🔧 Initializing MCP servers...");
    await LLMProviderManager.initializeMCPServers([playwrightMCPConfig]);

    console.log("✅ MCP servers initialized successfully!");
    console.log("");

    // Test web analysis task
    const task = "Take a screenshot of https://example.com. Be concise.";

    const config = {
      provider: "anthropic" as const,
      model: "claude-3-5-sonnet-20241022",
      systemPrompt:
        "You are a web analyst. Use browser tools to analyze websites. Use tools immediately and be concise.",
      mcpServers: ["playwright"],
      maxSteps: 2,
      toolChoice: "auto" as const,
      temperature: 0,
    };

    console.log("🌐 Testing web analysis with Playwright MCP tools...");
    console.log(`📋 Task: ${task}`);
    console.log("");

    const result = await LLMProviderManager.generateTextWithTools(task, config);

    console.log("📊 RESULTS:");
    console.log(`  📈 Tool calls made: ${result.toolCalls.length}`);
    console.log(`  🔧 Tools used: ${result.toolCalls.map((tc: any) => tc.toolName).join(", ")}`);
    console.log(`  📝 Steps executed: ${result.steps.length}`);
    console.log(`  📄 Response: ${result.text}`);
    console.log("");

    if (result.toolCalls.length > 0) {
      console.log("🎉 SUCCESS: MCP tools were called successfully!");
      console.log("🕷️  Playwright MCP integration is working!");
      console.log("✅ The web-analysis workspace should work correctly!");
    } else {
      console.log("❌ No tools were called");
    }

    // Cleanup
    await LLMProviderManager.disposeMCPResources();
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the demonstration
await demonstrateMCPIntegration();
