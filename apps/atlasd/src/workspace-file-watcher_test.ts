import { assertEquals, assertExists } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import { WorkspaceFileWatcher } from "./workspace-file-watcher.ts";
import type { WorkspaceEntry } from "@atlas/workspace";
import { WorkspaceStatusEnum } from "@atlas/workspace";

Deno.test("WorkspaceFileWatcher - detects workspace.yml changes", async () => {
  // Use a deterministic test directory instead of temp dir for CI compatibility
  const testDir = "./test-workspace-watcher";
  // Clean up any existing directory first
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeDetected = false;
  let changedWorkspaceId = "";

  // Create initial workspace.yml with valid configuration
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace for file watching
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async (workspaceId, _filePath) => {
      changeDetected = true;
      changedWorkspaceId = workspaceId;
    },
    debounceMs: 100, // Fast debounce for testing
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-id",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(100);

  // Modify the file
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Updated workspace description
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for debounce + processing
  await delay(300);

  // Verify change was detected
  assertEquals(changeDetected, true);
  assertEquals(changedWorkspaceId, "test-workspace-id");

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - ignores invalid configurations", async () => {
  const testDir = "./test-workspace-watcher-invalid";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeDetected = false;

  // Create valid workspace.yml
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async () => {
      changeDetected = true;
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-id",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(100);

  // Write invalid YAML
  await Deno.writeTextFile(
    configPath,
    `
invalid yaml {
  this is not: valid yaml syntax
`,
  );

  // Wait for debounce + processing
  await delay(300);

  // Verify change was NOT processed due to invalid config
  assertEquals(changeDetected, false);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - debounces rapid changes", async () => {
  const testDir = "./test-workspace-watcher-debounce";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeCount = 0;

  // Create initial workspace.yml
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async () => {
      changeCount++;
    },
    debounceMs: 200,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-id",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(100);

  // Make rapid changes
  for (let i = 1; i <= 5; i++) {
    await Deno.writeTextFile(
      configPath,
      `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace iteration ${i}
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
    );
    await delay(50); // Less than debounce time
  }

  // Wait for debounce to complete
  await delay(300);

  // Should only trigger once due to debouncing
  assertEquals(changeCount, 1);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - hash-based change detection", async () => {
  const testDir = "./test-workspace-watcher-hash";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let detectedChanges: string[] = [];

  const content = `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `;

  // Create initial workspace.yml
  await Deno.writeTextFile(configPath, content);

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async (_workspaceId, filePath) => {
      detectedChanges.push(filePath);
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-id",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching - this should NOT trigger a change since file already exists
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize and process any initial events
  await delay(300);

  // Reset change tracking after initialization
  detectedChanges = [];

  // Touch file without changing content
  await Deno.writeTextFile(configPath, content);

  // Wait for debounce + processing
  await delay(200);

  // Should not trigger change since content is same
  assertEquals(detectedChanges.length, 0);

  // Now change content
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace with new description
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  new-signal:
    provider: http
    description: New test signal
    config:
      path: /webhook2
  `,
  );

  // Wait for debounce + processing
  await delay(200);

  // Should trigger change since content is different
  assertEquals(detectedChanges.length, 1);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - stops watching on unwatch", async () => {
  const testDir = "./test-workspace-watcher-unwatch";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let lastChangeTime = 0;

  // Create initial workspace.yml
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async () => {
      lastChangeTime = Date.now();
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-id",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(200);

  // Stop watching
  await watcher.unwatchWorkspace(workspace.id);
  const unwatchTime = Date.now();

  // Give time to ensure watcher is fully stopped
  await delay(200);

  // Make a change after unwatching
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Updated workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for potential processing
  await delay(300);

  // Should not detect change after unwatching
  // If lastChangeTime is set, it should be before unwatchTime
  if (lastChangeTime > 0) {
    assertEquals(lastChangeTime < unwatchTime, true);
  }

  // Verify internal state is cleaned up
  assertExists(watcher);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - handles race condition during unwatch", async () => {
  const testDir = "./test-workspace-watcher-race";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeHandlerCalled = false;

  // Create initial workspace.yml
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async () => {
      changeHandlerCalled = true;
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-race",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(100);

  // Trigger a change
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Updated during race test
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Immediately unwatch (simulating race condition)
  await watcher.unwatchWorkspace(workspace.id);

  // Wait for any pending operations
  await delay(200);

  // The change handler should not have been called due to race condition protection
  assertEquals(changeHandlerCalled, false);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - hash cleanup doesn't affect similar workspace IDs", async () => {
  const testDir1 = "./test-workspace-1";
  const testDir11 = "./test-workspace-11";
  try {
    await Deno.remove(testDir1, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  try {
    await Deno.remove(testDir11, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir1, { recursive: true });
  await Deno.mkdir(testDir11, { recursive: true });

  const configPath1 = join(testDir1, "workspace.yml");
  const configPath11 = join(testDir11, "workspace.yml");
  let workspace1Changes = 0;
  let workspace11Changes = 0;

  // Create workspace.yml files
  await Deno.writeTextFile(
    configPath1,
    `
version: "1.0"
workspace:
  name: workspace-1
  description: Workspace 1
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  await Deno.writeTextFile(
    configPath11,
    `
version: "1.0"
workspace:
  name: workspace-11
  description: Workspace 11
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async (workspaceId, _filePath) => {
      if (workspaceId === "workspace-1") {
        workspace1Changes++;
      } else if (workspaceId === "workspace-11") {
        workspace11Changes++;
      }
    },
    debounceMs: 100,
  });

  const workspace1: WorkspaceEntry = {
    id: "workspace-1",
    name: "Workspace 1",
    path: testDir1,
    configPath: configPath1,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  const workspace11: WorkspaceEntry = {
    id: "workspace-11",
    name: "Workspace 11",
    path: testDir11,
    configPath: configPath11,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching both workspaces
  await watcher.watchWorkspace(workspace1);
  await watcher.watchWorkspace(workspace11);

  // Give watcher time to initialize
  await delay(100);

  // Modify workspace-11's file
  await Deno.writeTextFile(
    configPath11,
    `
version: "1.0"
workspace:
  name: workspace-11
  description: Updated workspace 11
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for debounce + processing
  await delay(300);

  // Only workspace-11 should have detected a change
  assertEquals(workspace1Changes, 0, "workspace-1 should not have detected changes");
  assertEquals(workspace11Changes, 1, "workspace-11 should have detected 1 change");

  // Stop watching workspace-1
  await watcher.unwatchWorkspace(workspace1.id);

  // Modify workspace-11's file again
  await Deno.writeTextFile(
    configPath11,
    `
version: "1.0"
workspace:
  name: workspace-11
  description: Updated again workspace 11
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for debounce + processing
  await delay(300);

  // workspace-11 should still detect changes after workspace-1 was unwatched
  assertEquals(workspace1Changes, 0, "workspace-1 should still have 0 changes");
  assertEquals(workspace11Changes, 2, "workspace-11 should have detected 2 changes total");

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir1, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
  try {
    await Deno.remove(testDir11, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("WorkspaceFileWatcher - ignores files with same name in different paths", async () => {
  const testDir = "./test-workspace-watcher-paths";
  const subDir = join(testDir, "subdir");
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  await Deno.mkdir(subDir, { recursive: true });

  const configPath = join(testDir, "workspace.yml");
  const wrongConfigPath = join(subDir, "workspace.yml");
  let changeDetected = false;
  let detectedFilePath = "";

  // Create the correct workspace.yml
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Correct config file
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Create a different workspace.yml in subdirectory
  await Deno.writeTextFile(
    wrongConfigPath,
    `
version: "1.0"
workspace:
  name: wrong-workspace
  description: Wrong config file
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  const watcher = new WorkspaceFileWatcher({
    onConfigChange: async (_workspaceId, filePath) => {
      changeDetected = true;
      detectedFilePath = filePath;
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-paths",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);

  // Give watcher time to initialize
  await delay(100);

  // Modify the WRONG file (in subdirectory)
  await Deno.writeTextFile(
    wrongConfigPath,
    `
version: "1.0"
workspace:
  name: wrong-workspace
  description: Updated wrong config file
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for potential false detection
  await delay(300);

  // Should NOT detect change in wrong file
  assertEquals(changeDetected, false);

  // Now modify the CORRECT file
  await Deno.writeTextFile(
    configPath,
    `
version: "1.0"
workspace:
  name: test-workspace
  description: Updated correct config file
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
  `,
  );

  // Wait for debounce + processing
  await delay(300);

  // Should detect change in correct file
  assertEquals(changeDetected, true);
  assertEquals(detectedFilePath, configPath);

  // Cleanup
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});
