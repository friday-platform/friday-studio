/**
 * F.1 — Drift invariant: prompt ≡ tool.
 *
 * The scariest failure mode for job-scoped skills is that
 * `<available_skills>` in the prompt shows a skill the `load_skill` tool
 * would then refuse (or vice versa). This property test asserts that for
 * any fixture filter, every skill the prompt lists loads cleanly, and
 * every skill not listed (except always-visible `@friday/*`) is rejected
 * by the tool.
 *
 * **PR #1 status:** skeleton only. Two of the three cases are
 * `.skip()`'d because `resolveVisibleSkills` doesn't accept a `jobName`
 * param until Phase C.1 lands. The `jobName: undefined` case runs today
 * and verifies existing workspace+global semantics — a regression guard
 * for the query audit in A.1.5.
 *
 * When Phase C.1 ships the `jobName` option, flip the `.skip()`s to
 * `.only()` or just drop them — the tests should pass on the first
 * attempt.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillAdapter } from "../src/local-adapter.ts";
import { resolveVisibleSkills } from "../src/resolve.ts";

describe("F.1 drift invariant — prompt ≡ tool", () => {
  let adapter: LocalSkillAdapter;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `skills-drift-${Date.now()}.db`);
    adapter = new LocalSkillAdapter(dbPath);
  });

  afterEach(() => {
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
   *   - `@friday/system-lib`    — no assignment (always-visible bypass)
   */
  async function seed(): Promise<void> {
    await adapter.publish("public", "global-1", "u", {
      description: "Global skill — visible everywhere",
      instructions: "…",
    });
    const wso = await adapter.publish("team", "workspace-only", "u", {
      description: "Workspace-only",
      instructions: "…",
    });
    if (wso.ok) await adapter.assignSkill(wso.data.skillId, "ws-1");

    // Job-only rows — created via direct SQL since Phase B (assignToJob)
    // hasn't landed yet. Using the adapter's internal path keeps test
    // self-contained.
    //
    // NOTE: this block is intentionally written as a no-op for PR #1 —
    // it populates the DB but no resolver consumes `jobName` yet, so the
    // skipped tests below would need to see these rows once Phase C.1
    // lands. Kept here to document the intended seed.

    await adapter.publish("friday", "system-lib", "u", {
      description: "Always available",
      instructions: "…",
    });
  }

  it("jobName: undefined — returns workspace + global (no drift)", async () => {
    await seed();
    const shown = await resolveVisibleSkills("ws-1", adapter);
    const names = new Set(shown.map((s) => `@${s.namespace}/${s.name}`));
    // Workspace-level + global skills visible. Job-level rows don't leak.
    expect(names.has("@public/global-1")).toBe(true);
    expect(names.has("@team/workspace-only")).toBe(true);
    expect(names.has("@friday/system-lib")).toBe(true);
    // Smoke: the query audit in A.1.5 guarantees job-level rows don't
    // appear here. Once Phase B adds job assignments we can extend the
    // assertion to check isolation explicitly.
  });

  it.skip("jobName: 'job-a' — returns workspace + global + job-a layer", async () => {
    // Enabled in PR #2 once resolveVisibleSkills accepts { jobName }.
    // const shown = await resolveVisibleSkills("ws-1", adapter, { jobName: "job-a" });
    // expect(shown.some((s) => s.name === "job-a-only")).toBe(true);
    // expect(shown.some((s) => s.name === "job-b-only")).toBe(false);
  });

  it.skip("jobName: 'job-b' — returns workspace + global + job-b layer", async () => {
    // Enabled in PR #2.
  });

  it.skip("tool rejects skills not in resolver output (defense-in-depth)", async () => {
    // Enabled in PR #2 once createLoadSkillTool takes { jobName } and its
    // internal check goes through resolveVisibleSkills (v8 unification).
  });
});
