/**
 * Example: MCP Tools Integration with @atlas/tools
 *
 * This example shows how to automatically fetch tools from MCP servers
 * and integrate them with Atlas tools for LLM providers.
 */

import { getAtlasToolRegistry, MCPToolsAdapter, type MCPToolsAdapterConfig } from "@atlas/tools";
import { LLMProvider } from "@atlas/core";

/**
 * Example 1: Basic MCP tools fetching
 */
async function basicMCPToolsExample() {
  console.log("=== Basic MCP Tools Example ===");

  // Fetch tools from MCP servers
  const adapter = new MCPToolsAdapter();
  const result = await adapter.getTools({ mcpServers: ["my-mcp-server"] });

  if (!result.success) {
    throw new Error(`Failed to fetch MCP tools: ${result.error.message}`);
  }

  const mcpTools = [...result.data];

  console.log(`Fetched ${mcpTools.length} tools from MCP servers`);

  // Use with LLM Provider
  const response = await LLMProvider.generateText(
    "Help me analyze this data",
    {
      model: "claude-3-sonnet-20240229",
      tools: mcpTools, // Pass as Tools array
    },
  );

  console.log("LLM Response:", response.text);
}

/**
 * Example 2: Advanced MCP tools with filtering
 */
async function advancedMCPToolsExample() {
  console.log("=== Advanced MCP Tools with Filtering ===");

  const config: MCPToolsAdapterConfig = {
    mcpServers: ["server1", "server2"],
    filters: {
      // Only include tools matching these patterns
      include: [/^data_/, /^analysis_/],
      // Exclude tools matching these patterns
      exclude: [/dangerous/, /delete/],
    },
    cache: {
      enabled: true,
      ttl: 10 * 60 * 1000, // 10 minutes
    },
  };

  const adapter = new MCPToolsAdapter();
  const result = await adapter.getTools(config);

  if (!result.success) {
    throw new Error(`Failed to fetch MCP tools: ${result.error.message}`);
  }

  const mcpTools = [...result.data];
  console.log(`Fetched ${mcpTools.length} filtered tools`);
}

/**
 * Example 3: Combined Atlas and MCP tools
 */
async function combinedToolsExample() {
  console.log("=== Combined Atlas and MCP Tools ===");

  const registry = getAtlasToolRegistry();

  // Get combined tools (Atlas + MCP)
  const result = await registry.getAllToolsWithMCP({
    mcpServers: ["my-mcp-server"],
    filters: {
      include: [/^custom_/], // Only custom MCP tools
    },
  });

  console.log(`Atlas tools: ${Object.keys(result.atlasTools).length}`);
  console.log(`MCP tools: ${result.mcpTools.length}`);
  console.log(`Combined: ${Object.keys(result.combined).length}`);

  // Use combined tools with LLM
  const response = await LLMProvider.generateText(
    "Process this workflow using available tools",
    {
      model: "claude-3-sonnet-20240229",
      tools: result.combined, // Use combined tools object
    },
  );
}

/**
 * Example 4: Dynamic tool loading based on context
 */
async function dynamicToolLoadingExample(context: { userType: string; workspace: string }) {
  console.log("=== Dynamic Tool Loading ===");

  let mcpServers: string[] = [];

  // Load different MCP servers based on context
  switch (context.userType) {
    case "analyst":
      mcpServers = ["data-analysis-server", "visualization-server"];
      break;
    case "developer":
      mcpServers = ["code-analysis-server", "git-server"];
      break;
    default:
      mcpServers = ["basic-tools-server"];
  }

  const registry = getAtlasToolRegistry();

  // Get tools for this specific context
  const tools = await registry.getAllToolsWithMCP({
    mcpServers,
    filters: {
      include: [new RegExp(`^${context.workspace}_`)], // Workspace-specific tools
    },
    cache: {
      enabled: true,
      ttl: 5 * 60 * 1000, // 5 minutes
    },
  });

  console.log(`Loaded ${Object.keys(tools.combined).length} context-specific tools`);
  return tools.combined;
}

/**
 * Example 5: Error handling and fallbacks
 */
async function robustMCPToolsExample() {
  console.log("=== Robust MCP Tools with Error Handling ===");

  const registry = getAtlasToolRegistry();

  try {
    // Try to get MCP tools
    const tools = await registry.getAllToolsWithMCP({
      mcpServers: ["primary-server", "secondary-server"],
      cache: { enabled: true },
    });

    console.log(`Successfully loaded ${tools.mcpTools.length} MCP tools`);
    return tools.combined;
  } catch (error) {
    console.warn("MCP tools loading failed, falling back to Atlas tools only");
    console.error("Error:", error);

    // Fallback to Atlas tools only
    return registry.getAllTools();
  }
}

/**
 * Run all examples
 */
async function runExamples() {
  try {
    await basicMCPToolsExample();
    await advancedMCPToolsExample();
    await combinedToolsExample();
    await dynamicToolLoadingExample({ userType: "analyst", workspace: "data-project" });
    await robustMCPToolsExample();

    console.log("All examples completed successfully!");
  } catch (error) {
    console.error("Example failed:", error);
  }
}

// Run examples if this file is executed directly
if (import.meta.main) {
  runExamples();
}
