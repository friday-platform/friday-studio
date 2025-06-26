/**
 * Integration tests with ConfigLoader
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { FileSystemConfigurationAdapter } from "../config/filesystem-config-adapter.ts";
import { ConfigLoader } from "../../../src/core/config-loader.ts";

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

// Minimal valid configs that work with current schema
const ATLAS_CONFIG = `version: "1.0"

workspace:
  id: "atlas-platform"
  name: "Atlas Platform"
  
agents:
  platform-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Platform agent"
    
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

const WORKSPACE_CONFIG = `version: "1.0"

workspace:
  id: "550e8400-e29b-41d4-a716-446655440000"
  name: "Test Workspace"
  description: "Test workspace"

agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Test agent"

signals:
  test-signal:
    provider: "cli"
    description: "Test signal"

jobs:
  test-job:
    name: "test-job"
    description: "Test job"
    triggers:
      - signal: "test-signal"
    execution:
      strategy: "sequential"
      agents:
        - id: "test-agent"`;

Deno.test("ConfigLoader integrates with adapter successfully", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    await createTestFiles(tempDir, {
      "atlas.yml": ATLAS_CONFIG,
      "workspace.yml": WORKSPACE_CONFIG,
    });

    Deno.chdir(tempDir);

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const loader = new ConfigLoader(adapter);
    const config = await loader.load();

    // Verify structure
    expect(config.atlas).toBeDefined();
    expect(config.workspace).toBeDefined();
    expect(config.jobs).toBeDefined();

    // Verify atlas config loaded
    expect(config.atlas.workspace.name).toBe("Atlas Platform");
    expect(config.atlas.agents?.["platform-agent"]).toBeDefined();

    // Verify workspace config loaded
    expect(config.workspace.workspace.name).toBe("Test Workspace");
    expect(config.workspace.agents["test-agent"]).toBeDefined();

    // Verify jobs loaded from workspace
    expect(config.jobs["test-job"]).toBeDefined();
    expect(config.jobs["test-job"].description).toBe("Test job");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader handles job loading from separate files", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    await createTestFiles(tempDir, {
      "atlas.yml": ATLAS_CONFIG,
      "workspace.yml": WORKSPACE_CONFIG,
      "jobs/extra-job.yml": `name: "extra-job"
description: "Extra job from file"
execution:
  strategy: "parallel"
  agents:
    - id: "test-agent"`,
    });

    Deno.chdir(tempDir);

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const loader = new ConfigLoader(adapter);
    const config = await loader.load();

    // Should have both jobs - from workspace.yml and jobs/
    expect(Object.keys(config.jobs).length).toBe(2);
    expect(config.jobs["test-job"]).toBeDefined();
    expect(config.jobs["extra-job"]).toBeDefined();
    expect(config.jobs["extra-job"].description).toBe("Extra job from file");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader validates agent references in jobs", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    // Create a workspace config where the job references an agent that doesn't exist
    const workspaceWithBadRef = WORKSPACE_CONFIG.replace(
      '- id: "test-agent"',
      '- id: "non-existent-agent"',
    );

    await createTestFiles(tempDir, {
      "atlas.yml": ATLAS_CONFIG,
      "workspace.yml": workspaceWithBadRef,
    });

    Deno.chdir(tempDir);

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const loader = new ConfigLoader(adapter);

    // The ConfigLoader validates agent references and throws an error
    await expect(loader.load()).rejects.toThrow("references agent");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader merges platform and workspace agents", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    await createTestFiles(tempDir, {
      "atlas.yml": ATLAS_CONFIG,
      "workspace.yml": WORKSPACE_CONFIG,
    });

    Deno.chdir(tempDir);

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const loader = new ConfigLoader(adapter);
    const config = await loader.load();

    // Platform agents in atlas config
    expect(config.atlas.agents?.["platform-agent"]).toBeDefined();

    // Workspace agents in workspace config
    expect(config.workspace.agents["test-agent"]).toBeDefined();

    // Agents are kept separate, not merged
    expect(config.atlas.agents?.["test-agent"]).toBeUndefined();
    expect(config.workspace.agents["platform-agent"]).toBeUndefined();
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader preserves job triggers", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();

  try {
    await createTestFiles(tempDir, {
      "atlas.yml": ATLAS_CONFIG,
      "workspace.yml": WORKSPACE_CONFIG,
    });

    Deno.chdir(tempDir);

    const adapter = new FileSystemConfigurationAdapter(tempDir);
    const loader = new ConfigLoader(adapter);
    const config = await loader.load();

    const job = config.jobs["test-job"];
    expect(job.triggers).toBeDefined();
    expect(Array.isArray(job.triggers)).toBe(true);
    expect(job.triggers?.length).toBe(1);
    expect(job.triggers?.[0].signal).toBe("test-signal");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
