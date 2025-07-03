/**
 * Debug script to understand agent configuration merging for conversation workspace
 */

import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { join } from "@std/path";

const CONVERSATION_WORKSPACE_PATH = "./packages/system/conversation";

async function debugConversationWorkspaceConfig() {
  console.log("=== Debugging Conversation Workspace Agent Configuration Merging ===\n");

  // Load conversation workspace configuration
  console.log("1. Loading conversation workspace configuration...");
  const adapter = new FilesystemConfigAdapter();
  const configLoader = new ConfigLoader(adapter, CONVERSATION_WORKSPACE_PATH);

  // Load the merged configuration
  const mergedConfig = await configLoader.load();

  console.log(
    "\n2. Atlas configuration agents:",
    JSON.stringify(mergedConfig.atlas.agents, null, 2),
  );
  console.log(
    "\n3. Workspace configuration agents:",
    JSON.stringify(mergedConfig.workspace.agents, null, 2),
  );

  // Create merged agents like WorkspaceRuntime does
  const allAgents = {
    ...(mergedConfig.atlas?.agents || {}),
    ...(mergedConfig.workspace?.agents || {}),
  };

  console.log("\n4. Final merged agents:", JSON.stringify(allAgents, null, 2));

  // Check conversation-agent specifically
  const conversationAgent = allAgents["conversation-agent"];
  if (conversationAgent) {
    console.log("\n5. conversation-agent configuration:");
    console.log("   - Type:", conversationAgent.type);
    console.log("   - Agent:", conversationAgent.agent);
    console.log("   - Version:", conversationAgent.version);
    console.log("   - Config:", JSON.stringify(conversationAgent.config, null, 2));

    // Test the conversion
    console.log("\n6. Testing agent configuration conversion...");
    try {
      const convertedConfig = ConfigLoader.convertWorkspaceAgentConfig(conversationAgent as any);
      console.log("   - Converted type:", convertedConfig.type);
      console.log("   - Converted config:", JSON.stringify(convertedConfig, null, 2));
    } catch (error) {
      console.error("   - Conversion error:", error.message);
    }
  } else {
    console.log("\n5. ERROR: conversation-agent not found in merged configuration!");
  }

  // Also check if there's an atlas.yml in the workspace that might be overriding things
  console.log("\n7. Checking for local atlas.yml in conversation workspace...");
  try {
    const atlasPath = join(CONVERSATION_WORKSPACE_PATH, "atlas.yml");
    const atlasExists = await Deno.stat(atlasPath).then(() => true).catch(() => false);
    console.log("   - atlas.yml exists:", atlasExists);

    if (atlasExists) {
      const { load } = await import("@std/yaml");
      const atlasContent = await Deno.readTextFile(atlasPath);
      const atlasConfig = load(atlasContent) as any;
      console.log("   - Atlas config agents:", JSON.stringify(atlasConfig.agents, null, 2));
    }
  } catch (error) {
    console.log("   - Could not check atlas.yml:", error.message);
  }
}

if (import.meta.main) {
  await debugConversationWorkspaceConfig();
}
