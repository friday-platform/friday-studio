import { assertEquals, assertExists } from "@std/assert";
import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import * as yaml from "@std/yaml";
import { WorkspaceRegistryManager } from "./workspace-registry.ts";

// Set test mode to prevent auto-import during tests
Deno.env.set("DENO_TEST", "true");

// Helper to create a test workspace
async function createTestWorkspace(
  basePath: string,
  name: string,
  config?: Record<string, unknown>,
): Promise<string> {
  const workspacePath = join(basePath, name);
  await ensureDir(workspacePath);

  const workspaceConfig = config || {
    version: "1.0",
    workspace: {
      id: crypto.randomUUID(),
      name: `Test ${name}`,
      description: `Test workspace ${name}`,
    },
    agents: {},
    signals: {},
  };

  await Deno.writeTextFile(
    join(workspacePath, "workspace.yml"),
    yaml.stringify(workspaceConfig),
  );

  return workspacePath;
}

// Helper to create a test registry with custom path
function createTestRegistry(testDir: string): WorkspaceRegistryManager {
  // Temporarily override HOME to use test directory
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", testDir);
  const registry = new WorkspaceRegistryManager();
  // Restore original HOME
  if (originalHome) {
    Deno.env.set("HOME", originalHome);
  } else {
    Deno.env.delete("HOME");
  }
  return registry;
}

Deno.test("WorkspaceRegistry - discoverWorkspaces finds workspaces in common locations", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    // Create test workspaces in different locations
    await createTestWorkspace(join(testDir, "examples", "workspaces"), "workspace1");
    await createTestWorkspace(join(testDir, "workspaces"), "workspace2");
    await createTestWorkspace(testDir, "root-workspace");

    // Create a nested workspace that should also be found
    await createTestWorkspace(join(testDir, "examples", "workspaces", "nested"), "sub-workspace");

    // Create a non-workspace directory
    await ensureDir(join(testDir, "not-a-workspace"));

    const discovered = await registry.discoverWorkspaces(testDir);

    // Should find all 4 workspaces
    assertEquals(discovered.length, 4);

    // Verify paths are included
    const paths = discovered.map((p) => p.replace(testDir, "")).sort();
    assertEquals(paths.includes("/examples/workspaces/workspace1"), true);
    assertEquals(paths.includes("/workspaces/workspace2"), true);
    assertEquals(paths.includes("/root-workspace"), true);
    assertEquals(paths.includes("/examples/workspaces/nested/sub-workspace"), true);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - discoverWorkspaces respects max depth", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    // Create deeply nested workspace beyond max depth
    const deepPath = join(testDir, "a", "b", "c", "d", "e");
    await createTestWorkspace(deepPath, "too-deep");

    // Create workspace within max depth
    const shallowPath = join(testDir, "a", "b");
    await createTestWorkspace(shallowPath, "shallow");

    const discovered = await registry.discoverWorkspaces(testDir);

    // Should only find the shallow workspace
    assertEquals(discovered.length, 1);
    assertEquals(discovered[0].endsWith("/a/b/shallow"), true);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - discoverWorkspaces skips common non-workspace directories", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    // Create workspaces in directories that should be skipped
    await createTestWorkspace(join(testDir, "node_modules"), "should-skip1");
    await createTestWorkspace(join(testDir, ".git"), "should-skip2");
    await createTestWorkspace(join(testDir, "dist"), "should-skip3");
    await createTestWorkspace(join(testDir, ".atlas"), "should-skip4");

    // Create a valid workspace
    await createTestWorkspace(testDir, "valid-workspace");

    const discovered = await registry.discoverWorkspaces(testDir);

    // Should only find the valid workspace
    assertEquals(discovered.length, 1);
    assertEquals(discovered[0].endsWith("/valid-workspace"), true);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - importExistingWorkspaces imports discovered workspaces", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    await registry.initialize();

    // Create test workspaces
    const workspace1Path = await createTestWorkspace(
      join(testDir, "examples", "workspaces"),
      "import-test1",
      {
        workspace: {
          name: "Import Test 1",
          description: "First import test",
        },
      },
    );

    const workspace2Path = await createTestWorkspace(
      testDir,
      "import-test2",
      {
        workspace: {
          name: "Import Test 2",
          description: "Second import test",
        },
      },
    );

    // Import workspaces - pass testDir to prevent searching git root
    const imported = await registry.importExistingWorkspaces(testDir);
    assertEquals(imported, 2);

    // Verify they were registered
    const allWorkspaces = await registry.listAll();
    assertEquals(allWorkspaces.length, 2);

    // Verify workspace details
    const ws1 = allWorkspaces.find((w) => w.name === "Import Test 1");
    assertExists(ws1);
    assertEquals(ws1.metadata?.description, "First import test");
    // Compare normalized paths to handle symlink differences (/private/var vs /var)
    assertEquals(await Deno.realPath(ws1.path), await Deno.realPath(workspace1Path));

    const ws2 = allWorkspaces.find((w) => w.name === "Import Test 2");
    assertExists(ws2);
    assertEquals(ws2.metadata?.description, "Second import test");
    // Compare normalized paths to handle symlink differences (/private/var vs /var)
    assertEquals(await Deno.realPath(ws2.path), await Deno.realPath(workspace2Path));
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - importExistingWorkspaces skips already registered workspaces", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    await registry.initialize();

    // Create and manually register a workspace
    const workspacePath = await createTestWorkspace(testDir, "already-registered");
    await registry.register(workspacePath, {
      name: "Already Registered",
      description: "Pre-existing workspace",
    });

    // Create another workspace
    await createTestWorkspace(testDir, "new-workspace");

    // Import should only import the new workspace
    const imported = await registry.importExistingWorkspaces(testDir);
    assertEquals(imported, 1);

    // Verify total count
    const allWorkspaces = await registry.listAll();
    assertEquals(allWorkspaces.length, 2);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - importExistingWorkspaces handles invalid workspace.yml gracefully", async () => {
  const testDir = await Deno.makeTempDir();
  const registry = createTestRegistry(testDir);

  try {
    await registry.initialize();

    // Create workspace with invalid YAML
    const invalidPath = join(testDir, "invalid-yaml");
    await ensureDir(invalidPath);
    await Deno.writeTextFile(
      join(invalidPath, "workspace.yml"),
      "invalid: yaml: content: {{{",
    );

    // Create workspace with valid YAML but missing workspace section
    const noWorkspacePath = join(testDir, "no-workspace-section");
    await ensureDir(noWorkspacePath);
    await Deno.writeTextFile(
      join(noWorkspacePath, "workspace.yml"),
      yaml.stringify({ agents: {}, signals: {} }),
    );

    // Create valid workspace
    await createTestWorkspace(testDir, "valid");

    // Import should handle errors gracefully and import valid workspaces
    const imported = await registry.importExistingWorkspaces(testDir);

    // Should import all 3 (using directory names as fallback for invalid ones)
    assertEquals(imported, 3);

    const allWorkspaces = await registry.listAll();
    assertEquals(allWorkspaces.length, 3);

    // Check that invalid workspaces used directory names
    const invalidWs = allWorkspaces.find((w) => w.name === "invalid-yaml");
    assertExists(invalidWs);

    const noWs = allWorkspaces.find((w) => w.name === "no-workspace-section");
    assertExists(noWs);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test.ignore("WorkspaceRegistry - auto-import runs on initialization", async () => {
  const testDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    // Create test workspaces in expected locations
    await createTestWorkspace(join(testDir, "workspaces"), "auto-import1");
    await createTestWorkspace(testDir, "auto-import2");

    // Change to test directory to isolate from git root
    Deno.chdir(testDir);

    // Temporarily unset test mode to test auto-import
    Deno.env.delete("DENO_TEST");

    // Create registry without test mode flag to test auto-import
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", testDir);
    const registry = new WorkspaceRegistryManager();

    // Check what exists before import
    console.log("workspaces dir exists:", await exists(join(testDir, "workspaces")));
    console.log(
      "workspace 1 exists:",
      await exists(join(testDir, "workspaces", "auto-import1", "workspace.yml")),
    );
    console.log(
      "workspace 2 exists:",
      await exists(join(testDir, "auto-import2", "workspace.yml")),
    );

    // Initialize should auto-import
    await registry.initialize();

    // Restore original HOME
    if (originalHome) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }

    // Re-enable test mode
    Deno.env.set("DENO_TEST", "true");

    // Verify workspaces were imported
    const allWorkspaces = await registry.listAll();
    if (allWorkspaces.length !== 2) {
      console.log("Expected 2 workspaces, got:", allWorkspaces.length);
      console.log("Test dir:", testDir);
      console.log("Current dir:", Deno.cwd());
      console.log("Workspaces:", allWorkspaces.map((w) => ({ name: w.name, path: w.path })));
    }
    assertEquals(allWorkspaces.length, 2);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("WorkspaceRegistry - handles workspace discovery without git", async () => {
  const testDir = await Deno.makeTempDir();

  // Create a subdirectory that's definitely not in a git repo
  const nonGitDir = join(testDir, "not-git");
  await ensureDir(nonGitDir);

  const registry = await createTestRegistry(nonGitDir);

  try {
    // Create workspaces in non-git directory
    await createTestWorkspace(nonGitDir, "workspace1");
    await createTestWorkspace(join(nonGitDir, "subdir"), "workspace2");

    const discovered = await registry.discoverWorkspaces(nonGitDir);

    // Should find both workspaces
    assertEquals(discovered.length, 2);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});
