import type { WorkspaceEntry } from "../types.ts";
import { WorkspaceStatusEnum } from "../types.ts";
import { assertEquals, assertExists } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import { WorkspaceConfigWatcher } from "./config-file-watcher.ts";

Deno.test("WorkspaceConfigWatcher - detects workspace.yml changes", async () => {
  const testDir = "./test-workspace-watcher";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeDetected = false;
  let changedWorkspaceId = "";

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

  const watcher = new WorkspaceConfigWatcher({
    onConfigChange: (workspaceId, _filePath) => {
      changeDetected = true;
      changedWorkspaceId = workspaceId;
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

  await watcher.watchWorkspace(workspace);
  await delay(100);
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
  await delay(300);

  assertEquals(changeDetected, true);
  assertEquals(changedWorkspaceId, "test-workspace-id");

  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
});

Deno.test("WorkspaceConfigWatcher - ignores invalid configurations", async () => {
  const testDir = "./test-workspace-watcher-invalid";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeDetected = false;

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

  const watcher = new WorkspaceConfigWatcher({
    onConfigChange: () => {
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

  await watcher.watchWorkspace(workspace);
  await delay(100);

  await Deno.writeTextFile(
    configPath,
    `
invalid yaml {
  this is not: valid yaml syntax
`,
  );

  await delay(300);
  assertEquals(changeDetected, false);

  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
});

Deno.test("WorkspaceConfigWatcher - debounces rapid changes", async () => {
  const testDir = "./test-workspace-watcher-debounce";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let changeCount = 0;

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

  const watcher = new WorkspaceConfigWatcher({
    onConfigChange: () => {
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

  await watcher.watchWorkspace(workspace);
  await delay(100);

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
    await delay(50);
  }

  await delay(300);
  assertEquals(changeCount, 1);

  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
});

Deno.test("WorkspaceConfigWatcher - stops watching on unwatch", async () => {
  const testDir = "./test-workspace-watcher-unwatch";
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
  await Deno.mkdir(testDir, { recursive: true });
  const configPath = join(testDir, "workspace.yml");
  let lastChangeTime = 0;

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

  const watcher = new WorkspaceConfigWatcher({
    onConfigChange: () => {
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

  await watcher.watchWorkspace(workspace);
  await delay(200);
  await watcher.unwatchWorkspace(workspace.id);
  const unwatchTime = Date.now();
  await delay(200);
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
  await delay(300);
  if (lastChangeTime > 0) {
    assertEquals(lastChangeTime < unwatchTime, true);
  }
  assertExists(watcher);
  await watcher.stop();
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    /* ignore */
  }
});
