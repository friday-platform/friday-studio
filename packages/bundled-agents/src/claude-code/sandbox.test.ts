import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSandbox, sandboxOptions } from "./sandbox.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

describe("sandbox", () => {
  it("createSandbox creates unique temp dir", async () => {
    const sandbox = await createSandbox("test-session-1");
    try {
      expect(sandbox.workDir).toBeDefined();
      expect(await exists(sandbox.workDir)).toBe(true);
      expect(sandbox.workDir.includes("atlas-claude-test-session-1")).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("cleanup removes directory", async () => {
    const sandbox = await createSandbox("test-session-2");
    const dir = sandbox.workDir;
    expect(await exists(dir)).toBe(true);
    await sandbox.cleanup();
    expect(await exists(dir)).toBe(false);
  });

  it("cleanup handles already-deleted dir gracefully", async () => {
    const sandbox = await createSandbox("test-session-3");
    await fs.rm(sandbox.workDir, { recursive: true });
    // Should not throw
    await sandbox.cleanup();
  });

  it("sandboxOptions has expected shape", () => {
    expect(sandboxOptions.enabled).toBe(true);
    expect(sandboxOptions.autoAllowBashIfSandboxed).toBe(true);
  });
});
