/**
 * F.1 — Drift invariant: prompt ≡ tool.
 *
 * The scariest failure mode for job-scoped skills is that
 * `<available_skills>` in the prompt shows a skill the `load_skill` tool
 * would then refuse (or vice versa). For every seeded fixture, every
 * skill the resolver lists MUST load cleanly via the tool, and every
 * skill not listed MUST be rejected by the tool — regardless of which
 * (workspace, jobName) combination is tested.
 *
 * Covers:
 *   - `jobName: undefined` — workspace + global only (job rows hidden).
 *   - `jobName: "job-a"` — workspace + global + (ws-1, job-a) layer.
 *   - `jobName: "job-b"` — no overlap with job-a (job isolation).
 *   - Defense-in-depth: tool rejects skills the resolver doesn't return.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoadSkillTool } from "../src/load-skill-tool.ts";
import { LocalSkillAdapter } from "../src/local-adapter.ts";
import { resolveVisibleSkills } from "../src/resolve.ts";
import { SkillStorage } from "../src/storage.ts";

const TOOL_CALL_OPTS = { toolCallId: "test", messages: [] as never[], abortSignal: undefined };

describe("F.1 drift invariant — prompt ≡ tool", () => {
  let adapter: LocalSkillAdapter;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `skills-drift-${Date.now()}-${Math.random()}.db`);
    adapter = new LocalSkillAdapter(dbPath);

    // The load-skill tool always hits the lazy SkillStorage singleton — wire
    // it to this test's adapter so defense-in-depth checks see the same data
    // the resolver does.
    vi.spyOn(SkillStorage, "listUnassigned").mockImplementation(() => adapter.listUnassigned());
    vi.spyOn(SkillStorage, "listAssigned").mockImplementation((wsId) => adapter.listAssigned(wsId));
    vi.spyOn(SkillStorage, "listAssignmentsForJob").mockImplementation((ws, job) =>
      adapter.listAssignmentsForJob(ws, job),
    );
    vi.spyOn(SkillStorage, "get").mockImplementation((ns, name, version) =>
      adapter.get(ns, name, version),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(dbPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  /**
   * Seed a mixed-layer fixture:
   *   - `@public/global-1`      — no assignment (global)
   *   - `@team/workspace-only`  — workspace-level assignment to ws-1
   *   - `@team/job-a-only`      — job-level assignment to (ws-1, job-a)
   *   - `@team/job-b-only`      — job-level assignment to (ws-1, job-b)
   */
  async function seed(): Promise<void> {
    const global = await adapter.publish("public", "global-1", "u", {
      description: "Global skill — visible everywhere",
      instructions: "# Global instructions",
    });
    if (!global.ok) throw new Error(`seed global failed: ${global.error}`);

    const wso = await adapter.publish("team", "workspace-only", "u", {
      description: "Workspace-only",
      instructions: "# Workspace-only instructions",
    });
    if (!wso.ok) throw new Error(`seed workspace-only failed: ${wso.error}`);
    await adapter.assignSkill(wso.data.skillId, "ws-1");

    const ja = await adapter.publish("team", "job-a-only", "u", {
      description: "Job A only",
      instructions: "# Job A instructions",
    });
    if (!ja.ok) throw new Error(`seed job-a-only failed: ${ja.error}`);
    await adapter.assignToJob(ja.data.skillId, "ws-1", "job-a");

    const jb = await adapter.publish("team", "job-b-only", "u", {
      description: "Job B only",
      instructions: "# Job B instructions",
    });
    if (!jb.ok) throw new Error(`seed job-b-only failed: ${jb.error}`);
    await adapter.assignToJob(jb.data.skillId, "ws-1", "job-b");
  }

  /**
   * Asserts: for every skill the resolver lists, the tool loads it; for
   * every seeded skill the resolver does NOT list, the tool rejects it.
   */
  async function assertInvariant(
    workspaceId: string,
    jobName: string | undefined,
    allSeededRefs: string[],
  ): Promise<void> {
    const visible = await resolveVisibleSkills(workspaceId, adapter, { jobName });
    const visibleRefs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));

    const { tool, cleanup } = createLoadSkillTool({ workspaceId, jobName });
    try {
      // Every visible skill must load cleanly.
      for (const ref of visibleRefs) {
        // biome-ignore lint/style/noNonNullAssertion: test helper
        const result = await tool.execute!({ name: ref, reason: "test" }, TOOL_CALL_OPTS);
        expect(
          result,
          `expected ${ref} to load (visible to ${workspaceId}, ${jobName})`,
        ).not.toHaveProperty("error");
      }

      // Every seeded skill NOT visible must be rejected.
      for (const ref of allSeededRefs) {
        if (visibleRefs.has(ref)) continue;
        // biome-ignore lint/style/noNonNullAssertion: test helper
        const result = await tool.execute!({ name: ref, reason: "test" }, TOOL_CALL_OPTS);
        expect(
          result,
          `expected ${ref} to be blocked (not visible to ${workspaceId}, ${jobName})`,
        ).toHaveProperty("error");
      }
    } finally {
      await cleanup();
    }
  }

  const ALL_SEEDED = [
    "@public/global-1",
    "@team/workspace-only",
    "@team/job-a-only",
    "@team/job-b-only",
  ];

  it("jobName: undefined — returns workspace + global, blocks job-level rows", async () => {
    await seed();
    await assertInvariant("ws-1", undefined, ALL_SEEDED);

    // Explicit safety: both job-level rows must be rejected.
    const visible = await resolveVisibleSkills("ws-1", adapter);
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has("@public/global-1")).toBe(true);
    expect(refs.has("@team/workspace-only")).toBe(true);
    expect(refs.has("@team/job-a-only")).toBe(false);
    expect(refs.has("@team/job-b-only")).toBe(false);
  });

  it("jobName: 'job-a' — adds job-a layer, still excludes job-b", async () => {
    await seed();
    await assertInvariant("ws-1", "job-a", ALL_SEEDED);

    const visible = await resolveVisibleSkills("ws-1", adapter, { jobName: "job-a" });
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has("@public/global-1")).toBe(true);
    expect(refs.has("@team/workspace-only")).toBe(true);
    expect(refs.has("@team/job-a-only")).toBe(true);
    expect(refs.has("@team/job-b-only")).toBe(false);
  });

  it("jobName: 'job-b' — adds job-b layer, still excludes job-a", async () => {
    await seed();
    await assertInvariant("ws-1", "job-b", ALL_SEEDED);

    const visible = await resolveVisibleSkills("ws-1", adapter, { jobName: "job-b" });
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has("@team/job-b-only")).toBe(true);
    expect(refs.has("@team/job-a-only")).toBe(false);
  });

  it("tool rejects skills not in resolver output (defense-in-depth)", async () => {
    await seed();
    // Empty jobName, but job-a-only still exists in the catalog. A hallucinated
    // load_skill("@team/job-a-only") call should be blocked even though the
    // skill IS in the DB — it just isn't visible to this scope.
    const { tool, cleanup } = createLoadSkillTool({ workspaceId: "ws-1" });
    try {
      // biome-ignore lint/style/noNonNullAssertion: test helper
      const result = await tool.execute!(
        { name: "@team/job-a-only", reason: "hallucination" },
        TOOL_CALL_OPTS,
      );
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not available");
    } finally {
      await cleanup();
    }
  });
});
