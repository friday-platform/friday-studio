/**
 * E2 — verifies that `WorkspaceRuntime.createJobEngine` wires a
 * `resolveAgentType` callback into `FSMEngineOptions` that:
 *
 *   1. returns the declared `type` for workspace-config-declared agents
 *      (`workspace.agents.<id>.type`),
 *   2. maps legacy `type: "system"` config entries to "atlas" (same
 *      classifier semantics — fixed prompt),
 *   3. falls through to bundled system agents (workspace-chat,
 *      judge-agent) — they don't appear in workspace.agents but they're
 *      still atlas-class for the validate-classifier's user/atlas → skip
 *      rule (B1 rule 1 in `validate-classifier.ts`),
 *   4. returns undefined for truly unknown ids (existing behavior).
 *
 * Mock pattern matches `runtime-validation-defaults.test.ts`: intercept
 * `createEngine` to capture the options it receives and assert the
 * callback's return values directly.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capturedEngineOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@atlas/fsm-engine", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/fsm-engine")>();
  return {
    ...actual,
    createEngine: (
      definition: import("@atlas/fsm-engine").FSMDefinition,
      options: Record<string, unknown>,
    ) => {
      capturedEngineOptions.push(options);
      return new actual.FSMEngine(definition, options as never);
    },
  };
});

function buildConfig(
  opts: { agents?: Record<string, { type: string; [k: string]: unknown }> } = {},
): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test", description: "test" },
      signals: {
        "trigger-signal": { provider: "http", description: "Test", config: { path: "/t" } },
      },
      ...(opts.agents && { agents: opts.agents }),
      jobs: {
        "resolve-job": {
          triggers: [{ signal: "trigger-signal" }],
          fsm: {
            id: "resolve-job-fsm",
            initial: "idle",
            states: {
              idle: { on: { "trigger-signal": { target: "done" } } },
              done: { type: "final" },
            },
          },
        },
      },
    },
  } as MergedConfig;
}

async function captureResolveAgentType(
  config: MergedConfig,
): Promise<(agentId: string) => "llm" | "user" | "atlas" | undefined> {
  const testDir = makeTempDir({ prefix: "atlas_resolve_agent_type_test_" });
  const originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;

  try {
    const { WorkspaceRuntime } = await import("../runtime.ts");
    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
      platformModels: createStubPlatformModels(),
    });
    await runtime.initialize();
    await runtime.processSignal({
      id: "trigger-signal",
      type: "trigger-signal",
      data: {},
      timestamp: new Date(),
    });
    await runtime.shutdown();

    expect(capturedEngineOptions.length).toBeGreaterThan(0);
    const opts = capturedEngineOptions[0]!;
    expect(typeof opts.resolveAgentType).toBe("function");
    return opts.resolveAgentType as (agentId: string) => "llm" | "user" | "atlas" | undefined;
  } finally {
    if (originalAtlasHome) {
      process.env.FRIDAY_HOME = originalAtlasHome;
    } else {
      delete process.env.FRIDAY_HOME;
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

describe("WorkspaceRuntime.resolveAgentType (E2)", () => {
  beforeEach(() => {
    capturedEngineOptions.length = 0;
  });

  it("bundled system agent workspace-chat resolves to 'atlas'", async () => {
    const resolve = await captureResolveAgentType(buildConfig());
    expect(resolve("workspace-chat")).toBe("atlas");
  });

  it("bundled system agent judge-agent resolves to 'atlas'", async () => {
    const resolve = await captureResolveAgentType(buildConfig());
    expect(resolve("judge-agent")).toBe("atlas");
  });

  it("workspace-config-declared agent returns its declared type", async () => {
    const resolve = await captureResolveAgentType(
      buildConfig({
        agents: {
          "my-llm-agent": {
            type: "llm",
            description: "Local LLM agent",
            config: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              prompt: "you are a helper",
            },
          },
          "my-atlas-agent": {
            type: "atlas",
            agent: "web",
            description: "Atlas web agent",
            prompt: "browse",
          },
          "my-user-agent": { type: "user", agent: "my-py-agent", description: "User agent" },
        },
      }),
    );
    expect(resolve("my-llm-agent")).toBe("llm");
    expect(resolve("my-atlas-agent")).toBe("atlas");
    expect(resolve("my-user-agent")).toBe("user");
  });

  it("legacy type: 'system' workspace-config entry maps to 'atlas'", async () => {
    const resolve = await captureResolveAgentType(
      buildConfig({
        agents: {
          "legacy-system": {
            type: "system",
            agent: "conversation",
            description: "Legacy system agent",
          },
        },
      }),
    );
    expect(resolve("legacy-system")).toBe("atlas");
  });

  it("workspace-config wins over bundled lookup when same id is declared", async () => {
    // Author-overridable: if a workspace explicitly declares an agent with
    // the same id as a bundled system agent, the workspace's declaration
    // takes precedence. (Today's runtime won't actually let workspace-chat
    // be redeclared, but the resolver should still honor an explicit type.)
    const resolve = await captureResolveAgentType(
      buildConfig({
        agents: {
          "workspace-chat": {
            type: "llm",
            description: "Override",
            config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "override" },
          },
        },
      }),
    );
    expect(resolve("workspace-chat")).toBe("llm");
  });

  it("unknown agentId returns undefined", async () => {
    const resolve = await captureResolveAgentType(buildConfig());
    expect(resolve("definitely-not-a-real-agent-xyz")).toBeUndefined();
  });
});
