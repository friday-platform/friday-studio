import { assertEquals, assertExists } from "@std/assert";
import { exists } from "@std/fs";
import { createSandbox, sandboxOptions } from "./sandbox.ts";

Deno.test("createSandbox creates unique temp dir", async () => {
  const sandbox = await createSandbox("test-session-1");
  try {
    assertExists(sandbox.workDir);
    assertEquals(await exists(sandbox.workDir), true);
    assertEquals(sandbox.workDir.includes("atlas-claude-test-session-1"), true);
  } finally {
    await sandbox.cleanup();
  }
});

Deno.test("cleanup removes directory", async () => {
  const sandbox = await createSandbox("test-session-2");
  const dir = sandbox.workDir;
  assertEquals(await exists(dir), true);
  await sandbox.cleanup();
  assertEquals(await exists(dir), false);
});

Deno.test("cleanup handles already-deleted dir gracefully", async () => {
  const sandbox = await createSandbox("test-session-3");
  await Deno.remove(sandbox.workDir, { recursive: true });
  // Should not throw
  await sandbox.cleanup();
});

Deno.test("sandboxOptions has expected shape", () => {
  assertEquals(sandboxOptions.enabled, true);
  assertEquals(sandboxOptions.autoAllowBashIfSandboxed, true);
});
