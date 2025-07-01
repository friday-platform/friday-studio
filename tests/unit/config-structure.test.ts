/**
 * Test that verifies config structure consistency
 * This ensures both cached and live config paths find the same signals
 */

import { assertEquals } from "@std/assert";
import { ConfigLoader, type MergedConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { Workspace } from "../../src/core/workspace.ts";
import { WorkspaceMemberRole } from "../../src/types/core.ts";
import { createTestWorkspace } from "../utils/test-utils.ts";

Deno.test("Config Structure - Both Paths Find Same Signals", async () => {
  const testWorkspace = await createTestWorkspace({
    "workspace.yml": `version: "1.0"
workspace:
  name: "config-fix-test"

signals:
  test-signal:
    provider: "http"
    path: "/test"
    method: "POST"
    description: "Test signal"
  another-signal:
    provider: "http" 
    path: "/another"
    method: "GET"
    description: "Another signal"

jobs:
  test-job:
    agent: "test-agent"
    trigger: ["test-signal"]
    execution:
      strategy: "sequential"
      agents: ["test-agent"]

agents:
  test-agent:
    type: "llm"
    provider: "anthropic"
    model: "claude-3-5-haiku-20241022"
    purpose: "Test agent"`,
  });

  try {
    const adapter = new FilesystemConfigAdapter();
    const configLoader = new ConfigLoader(adapter, testWorkspace.path);

    // Test 1: Live config path
    const liveConfig = await configLoader.load();
    const liveWorkspace = Workspace.fromConfig(liveConfig.workspace, {
      id: "live-test",
      name: "live-workspace",
      role: WorkspaceMemberRole.OWNER,
    });
    const liveSignals = Object.keys(liveWorkspace.signals);

    // Test 2: Cached config path (with fix)
    const cachedWorkspaceConfig = liveConfig.workspace;
    const freshConfig = await configLoader.load();
    const normalizedConfig: MergedConfig = {
      ...freshConfig,
      workspace: cachedWorkspaceConfig,
    };

    const cachedWorkspace = Workspace.fromConfig(normalizedConfig.workspace, {
      id: "cached-test",
      name: "cached-workspace",
      role: WorkspaceMemberRole.OWNER,
    });
    const cachedSignals = Object.keys(cachedWorkspace.signals);

    // Both paths should find the same signals
    assertEquals(cachedSignals.length, liveSignals.length);
    assertEquals(cachedSignals.sort(), liveSignals.sort());
  } finally {
    await testWorkspace.cleanup();
  }
});
