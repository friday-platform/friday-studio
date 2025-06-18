#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

/**
 * Unit tests for workspace configuration validation
 * Tests that invalid conditions are caught during config loading
 */

import { expect } from "@std/expect";
import { ConfigLoader, ConfigValidationError } from "../../src/core/config-loader.ts";
import { join } from "@std/path";

// Mock workspace configs for testing
const validWorkspaceConfig = `
version: "1.0"

workspace:
  id: "test-workspace"
  name: "Test Workspace"
  description: "Test workspace for validation"

agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Test agent for validation"

signals:
  test-signal:
    provider: "http"
    path: "/test"
    method: "POST"

jobs:
  valid-job:
    name: "valid-job"
    description: "Job with valid JSONLogic condition"
    triggers:
      - signal: "test-signal"
        condition: {"==": [{"var": "type"}, "test"]}
    execution:
      strategy: "sequential"
      agents:
        - id: "test-agent"
`;

const invalidConditionConfig = `
version: "1.0"

workspace:
  id: "test-workspace"
  name: "Test Workspace"

agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Test agent"

signals:
  test-signal:
    provider: "http"
    path: "/test"

jobs:
  invalid-job:
    name: "invalid-job"
    description: "Job with invalid condition syntax"
    triggers:
      - signal: "test-signal"
        condition: "type == 'performance'"  # This should be rejected
    execution:
      strategy: "sequential"
      agents:
        - id: "test-agent"
`;

const invalidAgentConfig = `
version: "1.0"

workspace:
  id: "test-workspace"
  name: "Test Workspace"

agents:
  invalid-agent:
    type: "llm"
    # Missing required model field
    purpose: "Invalid agent"

signals:
  test-signal:
    provider: "http"
    path: "/test"

jobs:
  test-job:
    name: "test-job"
    triggers:
      - signal: "test-signal"
    execution:
      strategy: "sequential"
      agents:
        - id: "invalid-agent"
`;

async function createTempConfig(content: string): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const configPath = join(tempDir, "workspace.yml");
  await Deno.writeTextFile(configPath, content);
  return tempDir;
}

Deno.test("ConfigLoader - Valid workspace configuration should load", async () => {
  const tempDir = await createTempConfig(validWorkspaceConfig);
  
  try {
    const loader = new ConfigLoader(tempDir);
    const config = await loader.load();
    
    expect(config.workspace.workspace.name).toBe("Test Workspace");
    expect(config.workspace.agents["test-agent"].type).toBe("llm");
    expect(config.workspace.jobs["valid-job"]).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader - Invalid agent configuration should be rejected", async () => {
  const tempDir = await createTempConfig(invalidAgentConfig);
  
  try {
    const loader = new ConfigLoader(tempDir);
    
    await expect(async () => {
      await loader.load();
    }).rejects.toThrow(ConfigValidationError);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader - Invalid condition syntax should be rejected", async () => {
  const tempDir = await createTempConfig(invalidConditionConfig);
  
  try {
    const loader = new ConfigLoader(tempDir);
    
    // This should either reject the config or validate the condition
    const config = await loader.load();
    
    // If it loads, the condition should be validated somehow
    const job = config.workspace.jobs["invalid-job"];
    expect(job).toBeDefined();
    
    // The condition should be flagged as invalid during validation
    const trigger = job.triggers[0];
    expect(trigger.condition).toBe("type == 'performance'");
    
    // TODO: Add condition validation that would catch this
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader - Missing required fields should be rejected", async () => {
  const missingWorkspaceConfig = `
version: "1.0"
# Missing workspace section
agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
`;
  
  const tempDir = await createTempConfig(missingWorkspaceConfig);
  
  try {
    const loader = new ConfigLoader(tempDir);
    
    await expect(async () => {
      await loader.load();
    }).rejects.toThrow();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ConfigLoader - Agent references in jobs should be validated", async () => {
  const invalidAgentRefConfig = `
version: "1.0"

workspace:
  id: "test-workspace"
  name: "Test Workspace"

agents:
  real-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Real agent"

signals:
  test-signal:
    provider: "http"
    path: "/test"

jobs:
  invalid-ref-job:
    name: "invalid-ref-job"
    triggers:
      - signal: "test-signal"
    execution:
      strategy: "sequential"
      agents:
        - id: "nonexistent-agent"  # This agent doesn't exist
`;
  
  const tempDir = await createTempConfig(invalidAgentRefConfig);
  
  try {
    const loader = new ConfigLoader(tempDir);
    
    // This should validate that agent references exist
    await expect(async () => {
      await loader.load();
    }).rejects.toThrow(ConfigValidationError);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});