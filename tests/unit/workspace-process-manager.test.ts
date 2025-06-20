import { assertEquals, assertRejects } from "@std/assert";
import { WorkspaceProcessManager } from "../../src/core/workspace-process-manager.ts";
import { AtlasLogger } from "../../src/utils/logger.ts";

// Close logger after tests to prevent file leaks
const cleanup = () => {
  AtlasLogger.getInstance().close();
};

Deno.test("WorkspaceProcessManager - should validate process running check", async () => {
  try {
    const manager = new WorkspaceProcessManager();

    // Current process should be running
    const currentRunning = await manager.isProcessRunning(Deno.pid);
    assertEquals(currentRunning, true);

    // Non-existent process should not be running
    const fakeRunning = await manager.isProcessRunning(999999);
    assertEquals(fakeRunning, false);
  } finally {
    cleanup();
  }
});

Deno.test("WorkspaceProcessManager - should reject starting non-existent workspace", async () => {
  try {
    const manager = new WorkspaceProcessManager();

    await assertRejects(
      async () => {
        await manager.startDetached("non-existent-workspace-id");
      },
      Error,
      // The error occurs when trying to resolve the path
      "No such file or directory",
    );
  } finally {
    cleanup();
  }
});

Deno.test("WorkspaceProcessManager - should reject stopping non-existent workspace", async () => {
  try {
    const manager = new WorkspaceProcessManager();

    await assertRejects(
      async () => {
        await manager.stop("non-existent-workspace-id");
      },
      Error,
      "Workspace non-existent-workspace-id not found",
    );
  } finally {
    cleanup();
  }
});

// Note: Full integration tests for actually starting/stopping processes
// would require a test workspace and would take longer to run.
// These can be added later as integration tests.
