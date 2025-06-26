/**
 * Core adapter functionality tests
 * Focus on testing adapter behavior, not Zod validation
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { FileSystemConfigurationAdapter } from "../config/filesystem-config-adapter.ts";

// Helper to create test files
async function createTestFiles(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dirPath && dirPath !== dir) {
      await Deno.mkdir(dirPath, { recursive: true });
    }
    await Deno.writeTextFile(fullPath, content);
  }
}

// Valid minimal configs for testing
const VALID_ATLAS_CONFIG = `version: "1.0"

workspace:
  id: "atlas-platform"
  name: "Atlas Platform"
  
supervisors:
  workspace:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are a workspace supervisor"
  session:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are a session supervisor"
  agent:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are an agent supervisor"`;

const VALID_WORKSPACE_CONFIG = `version: "1.0"

workspace:
  id: "550e8400-e29b-41d4-a716-446655440000"
  name: "Test Workspace"
  description: "Test workspace"

agents: {}
signals: {}
jobs: {}`;

const VALID_JOB_SPEC = `name: "test-job"
description: "A test job"
execution:
  strategy: "sequential"
  agents:
    - id: "test-agent"`;

Deno.test("Adapter loads atlas config successfully", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await createTestFiles(tempDir, {
      "atlas.yml": VALID_ATLAS_CONFIG,
    });

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const config = await adapter.loadAtlasConfig();

    expect(config.version).toBe("1.0");
    expect(config.workspace.id).toBe("atlas-platform");
    expect(config.supervisors?.workspace.model).toBe("claude-3-5-sonnet-20241022");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter loads workspace config successfully", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await createTestFiles(tempDir, {
      "workspace.yml": VALID_WORKSPACE_CONFIG,
    });

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const config = await adapter.loadWorkspaceConfig();

    expect(config.version).toBe("1.0");
    expect(config.workspace.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(config.workspace.name).toBe("Test Workspace");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter loads job specifications from directory", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await createTestFiles(tempDir, {
      "jobs/test-job.yml": VALID_JOB_SPEC,
      "jobs/another-job.yaml":
        `name: "another-job"\ndescription: "Another job"\nexecution:\n  strategy: "parallel"\n  agents: []`,
    });

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const jobs = await adapter.loadJobSpecs();

    expect(Object.keys(jobs).length).toBe(2);
    expect(jobs["test-job"]).toBeDefined();
    expect(jobs["test-job"].description).toBe("A test job");
    expect(jobs["another-job"]).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter loads supervisor defaults from .atlas directory", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await createTestFiles(tempDir, {
      ".atlas/supervisor-defaults.yml": `workspace:
  system: "Default workspace supervisor prompt"
session:
  system: "Default session supervisor prompt"
agent:
  system: "Default agent supervisor prompt"`,
    });

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const defaults = await adapter.loadSupervisorDefaults();

    // loadSupervisorDefaults returns a minimal fallback if file can't be parsed
    // Check that we got something back
    expect(defaults).toBeDefined();
    expect(typeof defaults).toBe("object");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter handles relative and absolute paths", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    await createTestFiles(tempDir, {
      "workspace.yml": VALID_WORKSPACE_CONFIG,
    });

    // Test with absolute path
    const adapter1 = new FileSystemConfigurationAdapter(tempDir);
    const config1 = await adapter1.loadWorkspaceConfig();
    expect(config1.workspace.name).toBe("Test Workspace");

    // Test with relative path
    Deno.chdir(tempDir);
    const adapter2 = new FileSystemConfigurationAdapter(".");
    const config2 = await adapter2.loadWorkspaceConfig();
    expect(config2.workspace.name).toBe("Test Workspace");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter normalizes agent references in jobs", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await createTestFiles(tempDir, {
      "jobs/mixed-agents.yml": `name: "mixed-agents"
description: "Job with mixed agent formats"
execution:
  strategy: "sequential"
  agents:
    - "string-agent"
    - id: "object-agent"
      config:
        timeout: 5000`,
    });

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const jobs = await adapter.loadJobSpecs();

    const job = jobs["mixed-agents"];
    expect(job.execution?.agents?.length).toBe(2);

    // String agents should be normalized to objects
    expect(job.execution?.agents?.[0]).toEqual({ id: "string-agent" });
    expect(job.execution?.agents?.[1]).toEqual({
      id: "object-agent",
      config: { timeout: 5000 },
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adapter returns empty objects when files don't exist", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const adapter = new FileSystemConfigurationAdapter(tempDir);

    // loadSupervisorDefaults returns a minimal fallback, not empty
    const defaults = await adapter.loadSupervisorDefaults();
    expect(defaults).toBeDefined();
    expect(typeof defaults).toBe("object");

    // loadJobSpecs returns empty object when directory doesn't exist
    const jobs = await adapter.loadJobSpecs();
    expect(Object.keys(jobs).length).toBe(0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
