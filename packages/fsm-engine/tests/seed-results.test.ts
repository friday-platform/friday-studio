import { describe, expect, it } from "vitest";
import type { FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSMEngine.seedResults", () => {
  it("seeded __meta is visible in context.results inside code actions", async () => {
    const fsm: FSMDefinition = {
      id: "seed-visible",
      initial: "idle",
      states: {
        idle: {
          on: { GO: { target: "done", actions: [{ type: "code", function: "check_meta" }] } },
        },
        done: { type: "final" },
      },
      functions: {
        check_meta: {
          type: "action",
          code: `export default function check_meta(context) {
            var meta = context.results['__meta'];
            if (!meta) throw new Error('__meta not found in results');
            if (meta.repo_root !== '/fake/repo') {
              throw new Error('repo_root mismatch: ' + meta.repo_root);
            }
            if (meta.workspace_id !== 'test-ws') {
              throw new Error('workspace_id mismatch: ' + meta.workspace_id);
            }
          }`,
        },
      },
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

  it("throws after first signal processed", async () => {
    const fsm: FSMDefinition = {
      id: "seed-after-signal",
      initial: "idle",
      states: { idle: { on: { GO: { target: "working" } } }, working: {} },
    };

    const { engine } = await createTestEngine(fsm);
    await engine.signal({ type: "GO" });

    expect(() => {
      engine.seedResults({ __meta: { repo_root: "/too/late" } });
    }).toThrow(/cannot be called after a signal has been processed/);
  });

  it("merges multiple seedResults calls before first signal", async () => {
    const fsm: FSMDefinition = {
      id: "seed-merge",
      initial: "idle",
      states: {
        idle: {
          on: { GO: { target: "done", actions: [{ type: "code", function: "check_both" }] } },
        },
        done: { type: "final" },
      },
      functions: {
        check_both: {
          type: "action",
          code: `export default function check_both(context) {
            var meta = context.results['__meta'];
            var extra = context.results['__extra'];
            if (!meta) throw new Error('__meta not found');
            if (!extra) throw new Error('__extra not found');
            if (meta.repo_root !== '/repo') throw new Error('meta.repo_root wrong');
            if (extra.key !== 'value') throw new Error('extra.key wrong');
          }`,
        },
      },
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

    // Reset clears _hasProcessedSignal
    await engine.reset();

    // Should work again after reset
    engine.seedResults({ __meta: { repo_root: "/second" } });
    expect(engine.results["__meta"]).toEqual({ repo_root: "/second" });
  });
});
