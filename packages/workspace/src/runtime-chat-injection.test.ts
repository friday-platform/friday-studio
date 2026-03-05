/**
 * Tests for workspace direct chat: reserved signal validation and
 * auto-injection of the handle-chat job during initialize().
 *
 * Source: runtime.ts lines 318-404
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRuntime } from "./runtime.ts";

/** Minimal config with no signals and no jobs */
function createMinimalConfig(overrides?: {
  signals?: MergedConfig["workspace"]["signals"];
}): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test-workspace", description: "Test" },
      signals: overrides?.signals,
      jobs: {},
    },
  };
}

describe("workspace direct chat injection", () => {
  let testDir: string;
  let originalAtlasHome: string | undefined;

  beforeEach(() => {
    testDir = makeTempDir({ prefix: "atlas_chat_injection_test_" });
    originalAtlasHome = process.env.ATLAS_HOME;
    process.env.ATLAS_HOME = testDir;
  });

  afterEach(async () => {
    if (originalAtlasHome) {
      process.env.ATLAS_HOME = originalAtlasHome;
    } else {
      delete process.env.ATLAS_HOME;
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("throws when workspace config defines a reserved 'chat' signal", async () => {
    const config = createMinimalConfig({
      signals: {
        chat: {
          provider: "http",
          description: "User-defined chat signal",
          config: { path: "/chat" },
        },
      },
    });

    const runtime = new WorkspaceRuntime({ id: "my-workspace" }, config, {
      workspacePath: testDir,
      lazy: true,
    });

    await expect(runtime.initialize()).rejects.toThrow(/reserved/);
    await expect(runtime.initialize()).rejects.toThrow(/my-workspace/);
  });

  it("auto-injects handle-chat job for normal workspaces", async () => {
    const config = createMinimalConfig();

    const runtime = new WorkspaceRuntime({ id: "my-workspace" }, config, {
      workspacePath: testDir,
      lazy: true,
    });

    await runtime.initialize();

    const jobs = runtime.listJobs();
    const chatJob = jobs.find((j) => j.name === "handle-chat");
    expect(chatJob).toBeDefined();
    expect(chatJob?.description).toBe("Direct chat with workspace");

    // Validate signal binding
    expect(chatJob?.signals).toEqual(["chat"]);

    // Validate FSM definition structure
    const fsm = chatJob?.fsmDefinition;
    expect(fsm).toBeDefined();
    expect(fsm).toMatchObject({
      id: "my-workspace-chat",
      initial: "idle",
      states: {
        idle: { on: { chat: { target: "processing" } } },
        processing: {
          entry: expect.arrayContaining([
            expect.objectContaining({ type: "agent", agentId: "workspace-chat" }),
          ]),
          on: { chat_complete: { target: "idle" } },
        },
      },
    });

    await runtime.shutdown();
  });

  it("skips chat injection for atlas-conversation workspace", async () => {
    const config = createMinimalConfig();

    const runtime = new WorkspaceRuntime({ id: "atlas-conversation" }, config, {
      workspacePath: testDir,
      lazy: true,
    });

    await runtime.initialize();

    const jobs = runtime.listJobs();
    const chatJob = jobs.find((j) => j.name === "handle-chat");
    expect(chatJob).toBeUndefined();

    await runtime.shutdown();
  });
});
