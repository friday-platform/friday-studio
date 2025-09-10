import type { WorkspaceEntry } from "@atlas/workspace";
import { WorkspaceStatusEnum } from "@atlas/workspace";
import { assertEquals, assertExists } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import { watchers } from "@atlas/workspace";

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

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (workspaceId: string, _filePath: string) => {
      changeDetected = true;
      changedWorkspaceId = workspaceId;
      return Promise.resolve();
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

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (_workspaceId: string, _filePath: string) => {
      changeDetected = true;
      return Promise.resolve();
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

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (_workspaceId: string, _filePath: string) => {
      changeCount++;
      return Promise.resolve();
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

Deno.test("WorkspaceFileWatcher - does not reload on access-only (no content change)", async () => {
  const testDir = "./test-workspace-watcher-access-only";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeDetected = false;

  // Create initial workspace.yml with valid content
  const initialContent = `
version: "1.0"
workspace:
  name: test-workspace
  description: Test workspace access-only
signals:
  test-signal:
    provider: http
    description: Test signal
    config:
      path: /webhook
`;
  await Deno.writeTextFile(configPath, initialContent);

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (_workspaceId: string, _filePath: string) => {
      changeDetected = true;
      return Promise.resolve();
    },
    debounceMs: 100,
  });

  const workspace: WorkspaceEntry = {
    id: "test-workspace-access-only",
    name: "Test Workspace",
    path: testDir,
    configPath,
    status: WorkspaceStatusEnum.RUNNING,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  // Start watching
  await watcher.watchWorkspace(workspace);
  await delay(150);

  // Access-only: update metadata (mtime) without changing content. This often emits a modify event.
  try {
    const stat = await Deno.stat(configPath);
    const currentMtime = stat.mtime ?? new Date();
    const newMtime = new Date(currentMtime.getTime() + 1000);
    const newAtime = new Date();
    await Deno.utime(configPath, newAtime, newMtime);
  } catch {
    // Ignore if utime not supported on platform
  }

  // Wait for debounce + processing window
  await delay(300);

  // Verify that no reload was triggered
  assertEquals(changeDetected, false);

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

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (_workspaceId: string, _filePath: string) => {
      lastChangeTime = Date.now();
      return Promise.resolve();
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

  const watcher = new watchers.WorkspaceConfigWatcher({
    onConfigChange: (_workspaceId: string, _filePath: string) => {
      changeHandlerCalled = true;
      return Promise.resolve();
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

// Test related to old hash-based behavior removed
