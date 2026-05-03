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
 *   - `jobName: "job-a"` — workspace + global + (ws, job-a) layer.
 *   - `jobName: "job-b"` — no overlap with job-a (job isolation).
 *   - Defense-in-depth: tool rejects skills the resolver doesn't return.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createLoadSkillTool } from "../src/load-skill-tool.ts";
import { resolveVisibleSkills } from "../src/resolve.ts";
import { SkillStorage } from "../src/storage.ts";

const TOOL_CALL_OPTS = { toolCallId: "test", messages: [] as never[], abortSignal: undefined };

describe("F.1 drift invariant — prompt ≡ tool", () => {
  // Each test gets a unique suffix so the JetStream-backed singleton
  // shared across the worker doesn't carry over names/assignments
  // from one test to the next.
  let suffix: string;
  let ws: string;
  let publicNs: string;
  let teamNs: string;
  let allSeeded: string[];

  beforeEach(() => {
    suffix = crypto.randomUUID().slice(0, 8);
    ws = `ws-${suffix}`;
    publicNs = `public-${suffix}`;
    teamNs = `team-${suffix}`;
    allSeeded = [
      `@${publicNs}/global-1`,
      `@${teamNs}/workspace-only`,
      `@${teamNs}/job-a-only`,
      `@${teamNs}/job-b-only`,
    ];
  });

  /**
   * Seed a mixed-layer fixture for the current suffix:
   *   - `@<publicNs>/global-1`     — no assignment (global)
   *   - `@<teamNs>/workspace-only` — workspace-level assignment to ws
   *   - `@<teamNs>/job-a-only`     — job-level assignment to (ws, job-a)
   *   - `@<teamNs>/job-b-only`     — job-level assignment to (ws, job-b)
   */
  async function seed(): Promise<void> {
    const global = await SkillStorage.publish(publicNs, "global-1", "u", {
      description: "Global skill — visible everywhere",
      instructions: "# Global instructions",
    });
    if (!global.ok) throw new Error(`seed global failed: ${global.error}`);

    const wso = await SkillStorage.publish(teamNs, "workspace-only", "u", {
      description: "Workspace-only",
      instructions: "# Workspace-only instructions",
    });
    if (!wso.ok) throw new Error(`seed workspace-only failed: ${wso.error}`);
    await SkillStorage.assignSkill(wso.data.skillId, ws);

    const ja = await SkillStorage.publish(teamNs, "job-a-only", "u", {
      description: "Job A only",
      instructions: "# Job A instructions",
    });
    if (!ja.ok) throw new Error(`seed job-a-only failed: ${ja.error}`);
    await SkillStorage.assignToJob(ja.data.skillId, ws, "job-a");

    const jb = await SkillStorage.publish(teamNs, "job-b-only", "u", {
      description: "Job B only",
      instructions: "# Job B instructions",
    });
    if (!jb.ok) throw new Error(`seed job-b-only failed: ${jb.error}`);
    await SkillStorage.assignToJob(jb.data.skillId, ws, "job-b");
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
    const visible = await resolveVisibleSkills(workspaceId, SkillStorage, { jobName });
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

  it("jobName: undefined — returns workspace + global, blocks job-level rows", async () => {
    await seed();
    await assertInvariant(ws, undefined, allSeeded);

    // Explicit safety: both job-level rows must be rejected.
    const visible = await resolveVisibleSkills(ws, SkillStorage);
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has(`@${publicNs}/global-1`)).toBe(true);
    expect(refs.has(`@${teamNs}/workspace-only`)).toBe(true);
    expect(refs.has(`@${teamNs}/job-a-only`)).toBe(false);
    expect(refs.has(`@${teamNs}/job-b-only`)).toBe(false);
  });

  it("jobName: 'job-a' — adds job-a layer, still excludes job-b", async () => {
    await seed();
    await assertInvariant(ws, "job-a", allSeeded);

    const visible = await resolveVisibleSkills(ws, SkillStorage, { jobName: "job-a" });
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has(`@${publicNs}/global-1`)).toBe(true);
    expect(refs.has(`@${teamNs}/workspace-only`)).toBe(true);
    expect(refs.has(`@${teamNs}/job-a-only`)).toBe(true);
    expect(refs.has(`@${teamNs}/job-b-only`)).toBe(false);
  });

  it("jobName: 'job-b' — adds job-b layer, still excludes job-a", async () => {
    await seed();
    await assertInvariant(ws, "job-b", allSeeded);

    const visible = await resolveVisibleSkills(ws, SkillStorage, { jobName: "job-b" });
    const refs = new Set(visible.map((s) => `@${s.namespace}/${s.name}`));
    expect(refs.has(`@${teamNs}/job-b-only`)).toBe(true);
    expect(refs.has(`@${teamNs}/job-a-only`)).toBe(false);
  });

  it("tool rejects skills not in resolver output (defense-in-depth)", async () => {
    await seed();
    // Empty jobName, but job-a-only still exists in the catalog. A hallucinated
    // load_skill("@team/job-a-only") call should be blocked even though the
    // skill IS in the DB — it just isn't visible to this scope.
    const { tool, cleanup } = createLoadSkillTool({ workspaceId: ws });
    try {
      // biome-ignore lint/style/noNonNullAssertion: test helper
      const result = await tool.execute!(
        { name: `@${teamNs}/job-a-only`, reason: "hallucination" },
        TOOL_CALL_OPTS,
      );
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not available");
    } finally {
      await cleanup();
    }
  });
});
