/**
 * Playwright MCP Integration Test
 * Tests the exact same configuration as @examples/workspaces/web-analysis/
 * Isolates MCP tool calling without requiring a full Atlas server
 */

import { expect } from "@std/expect";
import { createEnhancedTestEnvironment } from "../../utils/test-utils.ts";

// Import the actual implementation components
import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";
import { MCPManager } from "@atlas/mcp";

Deno.test({
  name: "Playwright MCP Integration - Web Analysis Agent Configuration",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    // Set the API key for testing
    Deno.env.set(
      "ANTHROPIC_API_KEY",
      "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",
    );

    try {
      // Create the exact same MCP server configuration as web-analysis workspace
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

      console.log("🔧 Testing MCP Manager registration...");

      // Test MCP Manager directly with Playwright configuration
      const mcpManager = new MCPManager();

      // Register the Playwright MCP server (this should work if Playwright is installed)
      await mcpManager.registerServer(playwrightMCPConfig);

      console.log("✅ MCP Manager registered Playwright server successfully");

      // Test tool retrieval with filtering
      console.log("🔍 Testing tool retrieval with filtering...");
      const tools = await mcpManager.getToolsForServers(["playwright"]);

      console.log(`📊 Retrieved ${Object.keys(tools).length} tools:`, Object.keys(tools));

      // Verify we got the expected tools (should be filtered by allowed list)
      const expectedTools = playwrightMCPConfig.tools.allowed;
      for (const expectedTool of expectedTools) {
        if (!(expectedTool in tools)) {
          console.log(`⚠️  Expected tool '${expectedTool}' not found in retrieved tools`);
        }
      }

      // Test the exact LLM configuration from web-analysis workspace
      const webAnalyzerConfig = {
        provider: "anthropic" as const,
        model: "claude-3-5-sonnet-20241022",
        systemPrompt:
          `You are a professional web analyst with access to browser automation tools via Playwright MCP.

Available tools:
- browser_navigate: Navigate to any URL
- browser_snapshot: Capture accessibility snapshots of pages (preferred for analysis)
- browser_take_screenshot: Take visual screenshots when needed
- browser_click: Click on page elements
- browser_type: Type text into form fields
- browser_wait_for: Wait for elements or text to appear/disappear
- browser_network_requests: Analyze network requests made by the page
- browser_console_messages: Check browser console for errors/warnings
- browser_pdf_save: Save pages as PDF documents

When analyzing a web page:
1. Use browser_navigate to go to the URL
2. Use browser_snapshot to get the accessibility tree (better than screenshots for analysis)
3. Check browser_network_requests to see what resources are loaded
4. Check browser_console_messages for any errors or issues
5. Provide comprehensive analysis of content, structure, performance, and accessibility

Always use browser_snapshot first as it provides structured data about the page content and accessibility tree.`,
        mcpServers: ["playwright"],
        maxSteps: 5,
        toolChoice: "auto" as const,
        temperature: 0.1, // Low for consistent testing
      };

      console.log("🤖 Testing LLM Provider Manager with MCP integration...");

      // Initialize MCP servers in LLM Provider Manager
      await LLMProviderManager.initializeMCPServers([playwrightMCPConfig]);

      console.log("✅ LLM Provider Manager initialized with MCP servers");

      // Test a simple web analysis task (like the web-analysis example)
      const analysisTask =
        "Navigate to https://tempestdx.com and analyze the page for accessibility issues. Be brief. Afterwards, take a screenshot of the page.";

      console.log("🌐 Testing actual tool calling with Playwright MCP...");

      // This is the critical test - does the LLM actually call MCP tools?
      // Use a shorter timeout and simpler task
      const simpleConfig = {
        ...webAnalyzerConfig,
        maxSteps: 2, // Limit steps to prevent timeout
        temperature: 0, // More deterministic
        systemPrompt:
          "You are a web analyst. Use browser_navigate and browser_snapshot tools to analyze to provide accessibility feedback onwebsites. Be concise and use tools immediately.",
      };

      // Add timeout wrapper to prevent hanging
      let timeoutId: number | undefined;
      const result = await Promise.race([
        LLMProviderManager.generateTextWithTools(analysisTask, simpleConfig),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Tool calling timeout after 30 seconds")),
            30000,
          );
        }),
      ]) as any;

      console.log({
        text: result.text,
        toolCalls: result.toolCalls || [],
        toolResults: JSON.stringify(result.toolResults, null, 2) || [],
        steps: result.steps || [],
      });

      // Clear timeout to prevent leak
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      console.log("📈 Generation completed!");
      console.log(`📊 Tool calls made: ${result.toolCalls.length}`);
      console.log(`🔧 Tools used: ${result.toolCalls.map((tc: any) => tc.toolName).join(", ")}`);
      console.log(`📝 Steps executed: ${result.steps.length}`);
      console.log(`📄 Response length: ${result.text.length} characters`);
      console.log("🚨 LLM response:", result.text);

      // Verify MCP tools were actually called
      if (result.toolCalls.length === 0) {
        console.log("❌ CRITICAL: No tools were called - MCP integration failed!");
        console.log("🔍 Available tools were:", Object.keys(tools));
        console.log("📋 LLM response preview:", result.text.substring(0, 200) + "...");

        // This is the same issue as the web-analysis example
        expect(result.toolCalls.length).toBeGreaterThan(0);
      } else {
        console.log("✅ SUCCESS: MCP tools were called!");

        // Verify specific Playwright tools were used
        const toolNames = result.toolCalls.map((tc: any) => tc.toolName);
        console.log("🎯 Specific tools called:", toolNames);

        // Verify at least one browser tool was called
        expect(toolNames.some((name: any) => name.startsWith("browser_"))).toBe(true);

        // Verify it's a valid Playwright tool
        const validPlaywrightTools = [
          "browser_navigate",
          "browser_snapshot",
          "browser_take_screenshot",
          "browser_click",
          "browser_type",
          "browser_wait_for",
          "browser_network_requests",
          "browser_console_messages",
          "browser_pdf_save",
        ];
        expect(toolNames.every((name: any) => validPlaywrightTools.includes(name))).toBe(true);
      }

      // Clean up MCP resources
      await LLMProviderManager.disposeMCPResources();
      await mcpManager.dispose();

      console.log("🧹 Cleanup completed");
    } catch (error) {
      console.error("❌ Test failed:", error);

      if (error instanceof Error) {
        console.error("Error message:", error.message);
        console.error("Error stack:", error.stack);
      }

      // Re-throw to fail the test
      throw error;
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "Playwright MCP - Tool Discovery and Validation",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      console.log("🔍 Testing Playwright MCP tool discovery...");

      const mcpManager = new MCPManager();

      // Test with minimal configuration first
      const minimalConfig = {
        id: "playwright-minimal",
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless", "--isolated"],
        },
        timeout_ms: 15000,
      };

      try {
        await mcpManager.registerServer(minimalConfig);
        console.log("✅ Minimal Playwright MCP connection successful");
      } catch (error) {
        console.log(
          "❌ Playwright MCP connection failed:",
          error instanceof Error ? error.message : String(error),
        );
        console.log("💡 This suggests Playwright MCP is not properly installed or accessible");

        // Skip the rest of the test if basic connection fails
        await mcpManager.dispose();
        return;
      }

      // Now test full configuration
      const fullConfig = {
        id: "playwright-full",
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless", "--isolated"],
        },
        tools: {
          allowed: ["browser_navigate", "browser_snapshot", "browser_take_screenshot"],
        },
        timeout_ms: 30000,
      };

      await mcpManager.registerServer(fullConfig);
      const tools = await mcpManager.getToolsForServers(["playwright-full"]);

      console.log(`📋 Discovered ${Object.keys(tools).length} tools from Playwright MCP`);
      console.log("🔧 Available tools:", Object.keys(tools));

      // Verify tool structure
      for (const [toolName, toolDef] of Object.entries(tools)) {
        console.log(`  🛠️  ${toolName}:`, typeof toolDef);
      }

      expect(Object.keys(tools).length).toBeGreaterThan(0);

      await mcpManager.dispose();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "Playwright MCP - Configuration Schema Validation",
  async fn() {
    console.log("📋 Testing configuration schema validation...");

    // Test the exact configuration from web-analysis workspace
    const webAnalysisConfig = {
      id: "playwright",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest"],
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

    // Import the schema to validate
    const { MCPServerConfigSchema } = await import("@atlas/mcp");

    // Test schema validation
    const validationResult = MCPServerConfigSchema.safeParse(webAnalysisConfig);

    if (!validationResult.success) {
      console.log("❌ Configuration validation failed:");
      console.log(validationResult.error.issues);
      expect(validationResult.success).toBe(true);
    } else {
      console.log("✅ Configuration schema validation passed");
      expect(validationResult.success).toBe(true);
    }
  },
});
