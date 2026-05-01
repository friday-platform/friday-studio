/**
 * Tests for applyMutation orchestrator
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "@std/yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkspaceConfig } from "../workspace.ts";
import { applyMutation, FilesystemConfigWriter, resolveConfigPath } from "./apply.ts";
import { createTestConfig, expectError } from "./test-fixtures.ts";
import type { ConfigWriter } from "./types.ts";

function configToYaml(config: WorkspaceConfig): string {
  return stringifyYaml(config as Record<string, unknown>);
}

// ==============================================================================
// RESOLVE CONFIG PATH TESTS
// ==============================================================================

describe("resolveConfigPath", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns workspace.yml when it exists", async () => {
    await writeFile(join(testDir, "workspace.yml"), configToYaml(createTestConfig()));

    const result = await resolveConfigPath(testDir);

    expect(result.path).toBe(join(testDir, "workspace.yml"));
    expect(result.ephemeral).toBe(false);
  });

  test("returns eph_workspace.yml when workspace.yml does not exist", async () => {
    await writeFile(join(testDir, "eph_workspace.yml"), configToYaml(createTestConfig()));

    const result = await resolveConfigPath(testDir);

    expect(result.path).toBe(join(testDir, "eph_workspace.yml"));
    expect(result.ephemeral).toBe(true);
  });

  test("prefers workspace.yml when both exist", async () => {
    await writeFile(join(testDir, "workspace.yml"), configToYaml(createTestConfig()));
    await writeFile(join(testDir, "eph_workspace.yml"), configToYaml(createTestConfig()));

    const result = await resolveConfigPath(testDir);

    expect(result.path).toBe(join(testDir, "workspace.yml"));
    expect(result.ephemeral).toBe(false);
  });

  test("throws ConfigNotFoundError when neither file exists", async () => {
    await expect(resolveConfigPath(testDir)).rejects.toThrow("Workspace configuration not found");
  });
});

// ==============================================================================
// FILESYSTEM CONFIG WRITER TESTS
// ==============================================================================

describe("FilesystemConfigWriter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("writes config as YAML to specified path", async () => {
    const writer = new FilesystemConfigWriter();
    const config = createTestConfig({ workspace: { id: "written", name: "Written Workspace" } });
    const configPath = join(testDir, "workspace.yml");

    await writer.write(configPath, config);

    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("version: '1.0'");
    expect(content).toContain("id: written");
    expect(content).toContain("name: Written Workspace");
  });

  test("uses atomic write - writes to temp file then renames", async () => {
    const writer = new FilesystemConfigWriter();
    const config = createTestConfig({ workspace: { id: "atomic", name: "Atomic Test" } });
    const configPath = join(testDir, "workspace.yml");

    // Write initial content
    await writeFile(configPath, "original content");

    await writer.write(configPath, config);

    // Verify final content is correct
    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("id: atomic");

    // Verify temp file does not exist (was renamed)
    const tempExists = await fileExists(join(testDir, "workspace.yml.tmp"));
    expect(tempExists).toBe(false);
  });

  test("preserves original file when write to temp fails", async () => {
    const writer = new FilesystemConfigWriter();
    const config = createTestConfig({ workspace: { id: "new", name: "New Config" } });
    const configPath = join(testDir, "workspace.yml");
    const originalContent = "version: '1.0'\nworkspace:\n  id: original\n  name: Original\n";

    // Write initial content
    await writeFile(configPath, originalContent);

    // Make temp file path a directory to cause writeFile to fail
    await mkdir(join(testDir, "workspace.yml.tmp"), { recursive: true });

    await expect(writer.write(configPath, config)).rejects.toThrow();

    // Original file should be unchanged
    const content = await readFile(configPath, "utf-8");
    expect(content).toBe(originalContent);
  });

  test("cleans up temp file on successful write", async () => {
    const writer = new FilesystemConfigWriter();
    const config = createTestConfig({ workspace: { id: "test", name: "Test" } });
    const subDir = join(testDir, "subdir");
    await mkdir(subDir, { recursive: true });
    const configPath = join(subDir, "workspace.yml");
    const tempPath = join(subDir, "workspace.yml.tmp");

    // Write a file to the target location first
    await writeFile(configPath, "original");

    // Pre-create a stale temp file to verify it gets replaced
    await writeFile(tempPath, "stale temp content");

    // Write should succeed and the temp file should be renamed (not left behind)
    await writer.write(configPath, config);

    const tempExists = await fileExists(tempPath);
    expect(tempExists).toBe(false);

    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("id: test");
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// ==============================================================================
// APPLY MUTATION TESTS
// ==============================================================================

describe("applyMutation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("applies mutation and writes to workspace.yml", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const result = await applyMutation(testDir, (config) => ({
      ok: true,
      value: {
        ...config,
        signals: {
          webhook: {
            provider: "http" as const,
            description: "Test webhook",
            config: { path: "/hook" },
          },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.webhook).toBeDefined();
    }

    // Verify file was written
    const content = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(content).toContain("webhook");
    expect(content).toContain("/hook");
  });

  test("applies mutation and writes to eph_workspace.yml when persistent does not exist", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "eph_workspace.yml"), configToYaml(initialConfig));

    const result = await applyMutation(testDir, (config) => ({
      ok: true,
      value: {
        ...config,
        signals: {
          daily: {
            provider: "schedule" as const,
            description: "Daily schedule",
            config: { schedule: "0 9 * * *", timezone: "UTC" },
          },
        },
      },
    }));

    expect(result.ok).toBe(true);

    // Verify ephemeral file was written, not persistent
    const content = await readFile(join(testDir, "eph_workspace.yml"), "utf-8");
    expect(content).toContain("daily");
    expect(content).toContain("0 9 * * *");
  });

  test("returns mutation error without writing when mutation fails", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));
    const originalContent = await readFile(join(testDir, "workspace.yml"), "utf-8");

    const result = await applyMutation(testDir, () => ({
      ok: false,
      error: { type: "not_found", entityId: "missing", entityType: "signal" },
    }));

    expectError(result, "not_found");

    // Verify file was not modified
    const currentContent = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(currentContent).toBe(originalContent);
  });

  test("returns validation error when mutated config is invalid", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const result = await applyMutation(testDir, (config) => ({
      ok: true,
      value: {
        ...config,
        // Invalid: version must be "1.0"
        version: "2.0" as "1.0",
      },
    }));

    expectError(result, "validation", (e) =>
      expect(e.message).toContain("Mutated config failed validation"),
    );
  });

  test("uses custom writer when provided", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const mockWriter: ConfigWriter = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await applyMutation(testDir, (config) => ({ ok: true, value: config }), {
      writer: mockWriter,
    });

    expect(result.ok).toBe(true);
    expect(mockWriter.write).toHaveBeenCalledOnce();
    expect(mockWriter.write).toHaveBeenCalledWith(
      join(testDir, "workspace.yml"),
      expect.objectContaining({ version: "1.0" }),
    );
  });

  test("throws when config file does not exist", async () => {
    await expect(applyMutation(testDir, (config) => ({ ok: true, value: config }))).rejects.toThrow(
      "Workspace configuration not found",
    );
  });

  test("returns write error when writer throws", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const mockWriter: ConfigWriter = { write: vi.fn().mockRejectedValue(new Error("Disk full")) };

    const result = await applyMutation(testDir, (config) => ({ ok: true, value: config }), {
      writer: mockWriter,
    });

    expectError(result, "write", (e) => expect(e.message).toBe("Disk full"));
  });

  test("preserves existing config fields not touched by mutation", async () => {
    const initialConfig = createTestConfig({
      signals: {
        existing: {
          provider: "http" as const,
          description: "Existing signal",
          config: { path: "/existing" },
        },
      },
    });
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const result = await applyMutation(testDir, (config) => ({
      ok: true,
      value: {
        ...config,
        signals: {
          ...config.signals,
          new: {
            provider: "schedule" as const,
            description: "New signal",
            config: { schedule: "0 * * * *", timezone: "UTC" },
          },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.existing).toBeDefined();
      expect(result.value.signals?.new).toBeDefined();
    }
  });

  test("calls onBeforeWrite callback after validation but before write", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const callOrder: string[] = [];
    const mockWriter: ConfigWriter = {
      write: vi.fn().mockImplementation(() => {
        callOrder.push("write");
        return Promise.resolve();
      }),
    };
    const onBeforeWrite = vi.fn().mockImplementation(() => {
      callOrder.push("onBeforeWrite");
      return Promise.resolve();
    });

    const result = await applyMutation(testDir, (config) => ({ ok: true, value: config }), {
      writer: mockWriter,
      onBeforeWrite,
    });

    expect(result.ok).toBe(true);
    expect(onBeforeWrite).toHaveBeenCalledOnce();
    expect(onBeforeWrite).toHaveBeenCalledWith(
      join(testDir, "workspace.yml"),
      expect.objectContaining({ version: "1.0" }),
    );
    expect(callOrder).toEqual(["onBeforeWrite", "write"]);
  });

  test.each([
    {
      name: "mutation fails",
      mutate: () => ({
        ok: false as const,
        error: { type: "not_found" as const, entityId: "missing", entityType: "signal" as const },
      }),
    },
    {
      name: "validation fails",
      mutate: (config: WorkspaceConfig) => ({
        ok: true as const,
        value: { ...config, version: "2.0" as "1.0" },
      }),
    },
  ])("does not call onBeforeWrite when $name", async ({ mutate }) => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const onBeforeWrite = vi.fn();

    const result = await applyMutation(testDir, mutate, { onBeforeWrite });

    expect(result.ok).toBe(false);
    expect(onBeforeWrite).not.toHaveBeenCalled();
  });

  test("returns write error when onBeforeWrite throws", async () => {
    const initialConfig = createTestConfig();
    await writeFile(join(testDir, "workspace.yml"), configToYaml(initialConfig));

    const mockWriter: ConfigWriter = { write: vi.fn() };
    const onBeforeWrite = vi.fn().mockRejectedValue(new Error("History storage failed"));

    const result = await applyMutation(testDir, (config) => ({ ok: true, value: config }), {
      writer: mockWriter,
      onBeforeWrite,
    });

    expectError(result, "write", (e) => expect(e.message).toBe("History storage failed"));
    // Writer should not be called if onBeforeWrite fails
    expect(mockWriter.write).not.toHaveBeenCalled();
  });
});
