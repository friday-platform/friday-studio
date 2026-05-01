import { describe, expect, it } from "vitest";
import type { FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSMEngine.seedResults", () => {
  it("seeded __meta is visible in engine.results after signal", async () => {
    const fsm: FSMDefinition = {
      id: "seed-visible",
      initial: "idle",
      states: { idle: { on: { GO: { target: "done" } } }, done: { type: "final" } },
    };

    const { engine } = await createTestEngine(fsm);

    engine.seedResults({
      __meta: {
        repo_root: "/fake/repo",
        workspace_path: "/fake/repo/workspaces/test",
        workspace_id: "test-ws",
        platform_url: "http://localhost:8080",
      },
    });

    await engine.signal({ type: "GO" });
    expect(engine.state).toBe("done");
    expect(engine.results["__meta"]).toEqual({
      repo_root: "/fake/repo",
      workspace_path: "/fake/repo/workspaces/test",
      workspace_id: "test-ws",
      platform_url: "http://localhost:8080",
    });
  });

  it("does not throw between sessions (after signal completes)", async () => {
    const fsm: FSMDefinition = {
      id: "seed-between-sessions",
      initial: "idle",
      states: { idle: { on: { GO: { target: "working" } } }, working: {} },
    };

    const { engine } = await createTestEngine(fsm);
    await engine.signal({ type: "GO" });

    // After processing completes, seedResults is allowed again — this is the
    // multi-turn chat case where __meta must be re-seeded on each new session
    // without an explicit reset().
    expect(() => {
      engine.seedResults({ __meta: { repo_root: "/between-sessions" } });
    }).not.toThrow();
    expect(engine.results["__meta"]).toEqual({ repo_root: "/between-sessions" });
  });

  it("merges multiple seedResults calls before first signal", async () => {
    const fsm: FSMDefinition = {
      id: "seed-merge",
      initial: "idle",
      states: { idle: { on: { GO: { target: "done" } } }, done: { type: "final" } },
    };

    const { engine } = await createTestEngine(fsm);

    engine.seedResults({ __meta: { repo_root: "/repo" } });
    engine.seedResults({ __extra: { key: "value" } });

    await engine.signal({ type: "GO" });
    expect(engine.state).toBe("done");
    expect(engine.results["__meta"]).toEqual({ repo_root: "/repo" });
    expect(engine.results["__extra"]).toEqual({ key: "value" });
  });

  it("seedResults works after reset (new session)", async () => {
    const fsm: FSMDefinition = {
      id: "seed-after-reset",
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "working" } } },
        working: { on: { DONE: { target: "idle" } } },
      },
    };

    const { engine } = await createTestEngine(fsm);

    engine.seedResults({ __meta: { repo_root: "/first" } });
    await engine.signal({ type: "GO" });
    expect(engine.state).toBe("working");

    // Reset clears _processing and other engine state
    await engine.reset();

    // Should work again after reset
    engine.seedResults({ __meta: { repo_root: "/second" } });
    expect(engine.results["__meta"]).toEqual({ repo_root: "/second" });
  });
});
