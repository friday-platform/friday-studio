import { expect } from "@std/expect";
import { FilesystemWorkspaceCreationAdapter } from "../src/adapters/workspace-creation-adapter.ts";
import { join } from "@std/path";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Temp directory will be created per test to avoid leaks
let tempDir: string;

Deno.test("WorkspaceCreationAdapter - creates basic workspace directory", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;
    const name = "test-workspace";

    const workspacePath = await adapter.createWorkspaceDirectory(basePath, name);

    expect(workspacePath).toBe(join(basePath, name));

    // Verify directory was created
    const stat = await Deno.stat(workspacePath);
    expect(stat.isDirectory).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles collision detection with incremental naming", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;
    const name = "collision-test";

    // Create first workspace
    const path1 = await adapter.createWorkspaceDirectory(basePath, name);
    expect(path1).toBe(join(basePath, name));

    // Create second workspace with same name - should get -2
    const path2 = await adapter.createWorkspaceDirectory(basePath, name);
    expect(path2).toBe(join(basePath, `${name}-2`));

    // Create third workspace with same name - should get -3
    const path3 = await adapter.createWorkspaceDirectory(basePath, name);
    expect(path3).toBe(join(basePath, `${name}-3`));

    // Verify all directories exist
    await Deno.stat(path1);
    await Deno.stat(path2);
    await Deno.stat(path3);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - writes workspace configuration files", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const workspacePath = join(tempDir, "config-test");
    await Deno.mkdir(workspacePath);

    const testConfig = `
name: config-test
description: Test workspace configuration
agents:
  test-agent:
    type: llm
    purpose: Test agent
jobs:
  test-job:
    description: Test job
    agents:
      - test-agent
`.trim();

    await adapter.writeWorkspaceFiles(workspacePath, testConfig);

    // Verify workspace.yml was created with correct content
    const yamlPath = join(workspacePath, "workspace.yml");
    const yamlContent = await Deno.readTextFile(yamlPath);
    expect(yamlContent).toBe(testConfig);

    // Verify .env was created with template
    const envPath = join(workspacePath, ".env");
    const envContent = await Deno.readTextFile(envPath);
    expect(envContent).toContain("# Add your environment variables here");
    expect(envContent).toContain("ANTHROPIC_API_KEY=");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - creates nested directory structures", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = join(tempDir, "deeply", "nested", "path");
    const name = "nested-workspace";

    // Should create all parent directories
    const workspacePath = await adapter.createWorkspaceDirectory(basePath, name);

    expect(workspacePath).toBe(join(basePath, name));

    // Verify entire path was created
    const stat = await Deno.stat(workspacePath);
    expect(stat.isDirectory).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles special characters in workspace names", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;

    // Test various special character scenarios
    const testCases = [
      "workspace-with-dashes",
      "workspace_with_underscores",
      "workspace.with.dots",
      "workspace123",
      "UPPERCASE-workspace",
      "MixedCase-Workspace",
    ];

    for (const name of testCases) {
      const workspacePath = await adapter.createWorkspaceDirectory(basePath, name);
      expect(workspacePath).toBe(join(basePath, name));

      const stat = await Deno.stat(workspacePath);
      expect(stat.isDirectory).toBe(true);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles existing files with same name", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;
    const name = "file-collision";

    // Create a file with the target name
    const filePath = join(basePath, name);
    await Deno.writeTextFile(filePath, "This is a file, not a directory");

    // Should detect collision and use incremented name
    const workspacePath = await adapter.createWorkspaceDirectory(basePath, name);
    expect(workspacePath).toBe(join(basePath, `${name}-2`));

    // Verify original file still exists
    const fileContent = await Deno.readTextFile(filePath);
    expect(fileContent).toBe("This is a file, not a directory");

    // Verify new directory was created
    const stat = await Deno.stat(workspacePath);
    expect(stat.isDirectory).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles complex collision scenarios", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;
    const name = "complex";

    // Pre-create some directories with gaps in numbering
    await Deno.mkdir(join(basePath, name));
    await Deno.mkdir(join(basePath, `${name}-2`));
    await Deno.mkdir(join(basePath, `${name}-4`)); // Skip -3

    // Should find the first available slot
    const path1 = await adapter.createWorkspaceDirectory(basePath, name);
    expect(path1).toBe(join(basePath, `${name}-3`));

    // Next should be -5
    const path2 = await adapter.createWorkspaceDirectory(basePath, name);
    expect(path2).toBe(join(basePath, `${name}-5`));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - writes empty config correctly", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const workspacePath = join(tempDir, "empty-config");
    await Deno.mkdir(workspacePath);

    // Empty config
    await adapter.writeWorkspaceFiles(workspacePath, "");

    // Verify files were created
    const yamlPath = join(workspacePath, "workspace.yml");
    const envPath = join(workspacePath, ".env");

    const yamlContent = await Deno.readTextFile(yamlPath);
    expect(yamlContent).toBe("");

    const envContent = await Deno.readTextFile(envPath);
    expect(envContent).toBe("# Add your environment variables here\nANTHROPIC_API_KEY=\n");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - preserves YAML formatting", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const workspacePath = join(tempDir, "yaml-format");
    await Deno.mkdir(workspacePath);

    const complexYaml = `name: complex-workspace
description: |
  This is a multi-line
  description with special formatting
  and indentation preserved
agents:
  agent1:
    type: llm
    purpose: First agent
    model: claude-3-5-haiku-latest
    config:
      temperature: 0.7
      max_tokens: 1000
  agent2:
    type: remote
    purpose: Second agent
    endpoint: https://example.com
jobs:
  pipeline:
    description: Sequential pipeline
    triggers:
      - manual
      - webhook
    execution:
      strategy: sequential
      agents:
        - agent1
        - agent2
    retry:
      attempts: 3
      delay: 5000`;

    await adapter.writeWorkspaceFiles(workspacePath, complexYaml);

    const yamlPath = join(workspacePath, "workspace.yml");
    const savedContent = await Deno.readTextFile(yamlPath);
    expect(savedContent).toBe(complexYaml);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles unicode in workspace names", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;

    // Test unicode characters
    const unicodeNames = [
      "workspace-café",
      "workspace-日本語",
      "workspace-🚀",
      "workspace-Ñoño",
    ];

    for (const name of unicodeNames) {
      const workspacePath = await adapter.createWorkspaceDirectory(basePath, name);
      expect(workspacePath).toBe(join(basePath, name));

      const stat = await Deno.stat(workspacePath);
      expect(stat.isDirectory).toBe(true);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles permission errors gracefully", async () => {
  // Skip this test on Windows as permission handling is different
  if (Deno.build.os === "windows") {
    return;
  }

  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const restrictedPath = join(tempDir, "restricted");

    // Create directory with restricted permissions
    await Deno.mkdir(restrictedPath, { mode: 0o000 });

    try {
      await adapter.createWorkspaceDirectory(restrictedPath, "test");
      throw new Error("Expected permission error");
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      expect(error.message).toContain("Permission denied");
    }
  } finally {
    // Restore permissions before cleanup
    try {
      await Deno.chmod(join(tempDir, "restricted"), 0o755);
    } catch {
      // Ignore if it fails
    }
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - handles very long workspace names", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;

    // Create a very long name (but still valid for most filesystems)
    const longName = "workspace-" + "a".repeat(200);

    const workspacePath = await adapter.createWorkspaceDirectory(basePath, longName);
    expect(workspacePath).toBe(join(basePath, longName));

    const stat = await Deno.stat(workspacePath);
    expect(stat.isDirectory).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - concurrent collision handling", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();
    const basePath = tempDir;
    const name = "concurrent";

    // Create multiple workspaces concurrently
    const promises = Array(5).fill(null).map(() =>
      adapter.createWorkspaceDirectory(basePath, name)
    );

    const paths = await Promise.all(promises);

    // All paths should be unique thanks to atomic directory creation
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(5);

    // Verify all paths exist and are directories
    for (const path of paths) {
      const stat = await Deno.stat(path);
      expect(stat.isDirectory).toBe(true);
    }

    // Extract the directory names
    const dirNames = paths.map((p) => {
      const parts = p.split("/");
      return parts[parts.length - 1];
    });

    // Sort to verify we have the expected sequence
    dirNames.sort();

    // Should have created: concurrent, concurrent-2, concurrent-3, concurrent-4, concurrent-5
    expect(dirNames).toContain(name);
    expect(dirNames.some((d) => d === `${name}-2`)).toBe(true);
    expect(dirNames.some((d) => d === `${name}-3`)).toBe(true);
    expect(dirNames.some((d) => d === `${name}-4`)).toBe(true);
    expect(dirNames.some((d) => d === `${name}-5`)).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceCreationAdapter - respects base path structure", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemWorkspaceCreationAdapter();

    // Test different base path scenarios
    const testCases = [
      { base: tempDir, name: "root-level" },
      { base: join(tempDir, "projects"), name: "project-workspace" },
      { base: join(tempDir, "users", "alice"), name: "alice-workspace" },
      { base: join(tempDir, "teams", "engineering", "backends"), name: "api-workspace" },
    ];

    for (const { base, name } of testCases) {
      const workspacePath = await adapter.createWorkspaceDirectory(base, name);
      expect(workspacePath).toBe(join(base, name));
      expect(workspacePath.startsWith(base)).toBe(true);

      const stat = await Deno.stat(workspacePath);
      expect(stat.isDirectory).toBe(true);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
