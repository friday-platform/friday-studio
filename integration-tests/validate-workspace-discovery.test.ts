import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { parse } from "@std/yaml";
import { WorkspaceConfigSchema } from "../packages/config/src/workspace.ts";
import { WorkspaceManager } from "../packages/core/src/workspace-manager.ts";
import { createRegistryStorage, StorageConfigs } from "../src/core/storage/index.ts";

Deno.test("validate-examples - workspace discovery logic", async () => {
  console.log("\n🔍 Testing workspace discovery logic directly...");
  console.log("=" + "=".repeat(79));

  // Create a temporary in-memory registry
  const registry = await createRegistryStorage(StorageConfigs.memory());
  const manager = new WorkspaceManager(registry);

  // Count workspace.yml files in examples directory
  const examplesDir = join(Deno.cwd(), "examples");
  let expectedWorkspaceCount = 0;
  const walker = walk(examplesDir, {
    includeDirs: false,
    match: [/workspace\.yml$/],
    skip: [/node_modules/],
  });

  for await (const entry of walker) {
    try {
      // Pre-validate to make sure we are counting valid files
      const content = await Deno.readTextFile(entry.path);
      const data = parse(content);
      if (WorkspaceConfigSchema.safeParse(data).success) {
        expectedWorkspaceCount++;
      }
    } catch {
      // Ignore files that can't be parsed, they won't be loaded anyway
    }
  }

  // Initialize manager (this should trigger workspace discovery)
  await manager.initialize({
    registerSystemWorkspaces: false, // Skip system workspaces for cleaner test
  });

  // Get discovered workspaces
  const discoveredWorkspaces = await manager.list();
  const normalize = (p: string) => p.replace(/^\/private/, "");
  const filteredWorkspaces = discoveredWorkspaces.filter((ws) =>
    normalize(ws.path).startsWith(normalize(examplesDir)),
  );
  console.log(
    `\n📋 WorkspaceManager discovered ${filteredWorkspaces.length} workspaces in examples:`,
  );
  filteredWorkspaces.forEach((ws) => {
    console.log(`   - ${ws.name} (${ws.id}) - ${ws.path}`);
  });

  // Assert equality
  assertEquals(
    filteredWorkspaces.length,
    expectedWorkspaceCount,
    `Expected WorkspaceManager to discover ${expectedWorkspaceCount} workspaces in examples, but found ${filteredWorkspaces.length}. Check logs for validation errors.`,
  );

  console.log("\n✅ Workspace discovery test passed!");

  // Clean up resources
  await manager.close();
});
