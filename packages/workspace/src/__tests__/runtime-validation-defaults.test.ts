/**
 * B5 — verifies that the workspace + per-job `validation:` blocks parsed
 * from workspace config flow through `WorkspaceRuntime.createJobEngine`
 * into `FSMEngineOptions.workspaceValidation` / `jobValidation`.
 *
 * Mocks `@atlas/fsm-engine`'s FSMEngine constructor to capture the
 * options it receives — same pattern as `standing-orders-bootstrap.test.ts`
 * uses for AgentOrchestrator. Avoids spinning the full runtime stack.
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

  // The runtime spawns engines via `createEngine`, not the FSMEngine
  // class directly — intercept there. Real FSMEngine is still useful as
  // a base so the runtime's downstream calls (initialize / signal /
  // currentState getters) keep working. We just observe the options
  // passed in and let the rest run normally.
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

function buildConfig(opts: {
  workspaceValidation?: { default?: string; skill?: string };
  jobValidation?: { default?: string; skill?: string };
}): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test", description: "test" },
      signals: {
        "trigger-signal": { provider: "http", description: "Test", config: { path: "/t" } },
      },
      jobs: {
        "validation-job": {
          triggers: [{ signal: "trigger-signal" }],
          fsm: {
            id: "validation-job-fsm",
            initial: "idle",
            states: {
              idle: { on: { "trigger-signal": { target: "done" } } },
              done: { type: "final" },
            },
          },
          ...(opts.jobValidation && { validation: opts.jobValidation }),
        },
      },
      ...(opts.workspaceValidation && { validation: opts.workspaceValidation }),
    },
  } as MergedConfig;
}

async function spawnEngineForJob(config: MergedConfig): Promise<void> {
  const testDir = makeTempDir({ prefix: "atlas_validation_defaults_test_" });
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

describe("runtime threads validation defaults into FSMEngineOptions (B5)", () => {
  beforeEach(() => {
    capturedEngineOptions.length = 0;
  });

  it("workspace.validation flows into FSMEngineOptions.workspaceValidation", async () => {
    const config = buildConfig({ workspaceValidation: { default: "external" } });
    await spawnEngineForJob(config);

    expect(capturedEngineOptions.length).toBeGreaterThan(0);
    const opts = capturedEngineOptions[0]!;
    expect(opts.workspaceValidation).toEqual({ default: "external" });
    expect(opts.jobValidation).toBeUndefined();
  });

  it("job.validation flows into FSMEngineOptions.jobValidation", async () => {
    const config = buildConfig({ jobValidation: { default: "skip" } });
    await spawnEngineForJob(config);

    expect(capturedEngineOptions.length).toBeGreaterThan(0);
    const opts = capturedEngineOptions[0]!;
    expect(opts.jobValidation).toEqual({ default: "skip" });
    expect(opts.workspaceValidation).toBeUndefined();
  });

  it("both workspace + job validation flow through independently", async () => {
    const config = buildConfig({
      workspaceValidation: { default: "self", skill: "@ws/skill" },
      jobValidation: { default: "skip" },
    });
    await spawnEngineForJob(config);

    expect(capturedEngineOptions.length).toBeGreaterThan(0);
    const opts = capturedEngineOptions[0]!;
    expect(opts.workspaceValidation).toEqual({ default: "self", skill: "@ws/skill" });
    expect(opts.jobValidation).toEqual({ default: "skip" });
  });

  it("absent validation blocks → no validation options threaded (back-compat)", async () => {
    const config = buildConfig({});
    await spawnEngineForJob(config);

    expect(capturedEngineOptions.length).toBeGreaterThan(0);
    const opts = capturedEngineOptions[0]!;
    expect(opts.workspaceValidation).toBeUndefined();
    expect(opts.jobValidation).toBeUndefined();
  });
});
