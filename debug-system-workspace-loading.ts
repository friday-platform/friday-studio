/**
 * Debug script to understand how system workspaces load agent configurations
 */

import { SystemWorkspace } from "./src/core/system-workspace.ts";
import { Workspace } from "./src/core/workspace.ts";
import { WorkspaceMemberRole } from "./src/types/core.ts";
import { join } from "@std/path";

class ConversationSystemWorkspace extends SystemWorkspace {
  getName(): string {
    return "atlas-conversation";
  }

  getDescription(): string {
    return "Conversation management for Atlas with Tempest agent";
  }

  async loadWorkspaceConfig() {
    // Load from the actual conversation workspace.yml
    const { parse } = await import("@std/yaml");
    const configPath = join(this.workspacePath, "workspace.yml");
    const configContent = await Deno.readTextFile(configPath);
    return parse(configContent) as any;
  }

  registerRoutes(_app: any): void {
    // Not needed for this debug
  }
}

async function debugSystemWorkspaceLoading() {
  console.log("=== Debugging System Workspace Loading ===\n");

  const workspacePath = "./packages/system/conversation";

  console.log("1. Creating system workspace instance...");
  const systemWorkspace = new ConversationSystemWorkspace(workspacePath);

  console.log("2. Initializing system workspace...");
  await systemWorkspace.initialize();

  console.log("3. Getting runtime and checking configuration...");
  const runtime = systemWorkspace.getRuntime();

  if (runtime) {
    // Access the internal workspace object to see agents
    const workspace = (runtime as any).workspace;
    const config = (runtime as any).config;

    console.log("4. Workspace agents:", Object.keys(workspace.agents || {}));

    // Check each agent
    for (const [agentId, agent] of Object.entries(workspace.agents || {})) {
      console.log(`\n5. Agent: ${agentId}`);
      console.log("   - Type:", (agent as any).type);
      console.log("   - Config:", JSON.stringify((agent as any).config, null, 2));

      if (agentId === "conversation-agent") {
        console.log("   - FOUND conversation-agent!");
        console.log("   - Agent object:", JSON.stringify(agent, null, 2));
      }
    }

    console.log("\n6. Merged config atlas agents:", Object.keys(config?.atlas?.agents || {}));
    console.log("7. Merged config workspace agents:", Object.keys(config?.workspace?.agents || {}));

    // Check the merged config agents specifically for conversation-agent
    if (config?.workspace?.agents?.["conversation-agent"]) {
      console.log("\n8. conversation-agent in merged config:");
      console.log(JSON.stringify(config.workspace.agents["conversation-agent"], null, 2));
    }

    if (config?.atlas?.agents?.["conversation-agent"]) {
      console.log("\n9. conversation-agent in atlas config (THIS SHOULD BE EMPTY!):");
      console.log(JSON.stringify(config.atlas.agents["conversation-agent"], null, 2));
    }
  } else {
    console.log("4. ERROR: No runtime found!");
  }

  console.log("\n10. Shutting down...");
  await systemWorkspace.shutdown();
}

if (import.meta.main) {
  await debugSystemWorkspaceLoading();
}
