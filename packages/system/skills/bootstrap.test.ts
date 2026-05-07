/**
 * Bootstrap auto-stamp test for the bundled `validating-llm-outputs`
 * skill. Pt2's B3 added the skill to `packages/system/skills/` but
 * never asserted it actually lands in the system skills set on a
 * fresh daemon. This test wires `ensureSystemSkills()` against an
 * in-memory `SkillStorageAdapter` stub and verifies the skill is
 * published with the expected frontmatter (`user-invocable: false`)
 * and a stable body marker.
 *
 * Wider coverage of every bundled skill is intentionally out of
 * scope — this test exists to close the pt2 Open and acts as a
 * canary for the bootstrap loader's contract on this one skill.
 *
 * @module
 */

import {
  _setSkillStorageForTest,
  type PublishSkillInput,
  type Skill,
  type SkillStorageAdapter,
} from "@atlas/skills";
import type { Result } from "@atlas/utils";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSystemSkills, SYSTEM_SKILL_NAMESPACE, SYSTEM_USER_ID } from "./bootstrap.ts";

interface PublishCall {
  namespace: string;
  name: string;
  createdBy: string;
  input: PublishSkillInput;
}

/**
 * Minimal in-memory adapter capturing publish calls. `get` always
 * returns `null` so the bootstrap's "stored hash matches" shortcut
 * never fires — every bundled skill takes the publish path.
 */
function mkCapturingAdapter(): { adapter: SkillStorageAdapter; calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  const noop = <T>(value: T): Promise<Result<T, string>> =>
    Promise.resolve({ ok: true, data: value });

  const adapter: SkillStorageAdapter = {
    create: () => noop({ skillId: "stub-id" }),
    publish: (namespace, name, createdBy, input) => {
      calls.push({ namespace, name, createdBy, input });
      return noop({ id: `id-${name}`, version: 1, name, skillId: `sid-${name}` });
    },
    get: (): Promise<Result<Skill | null, string>> => noop(null),
    getById: (): Promise<Result<Skill | null, string>> => noop(null),
    getBySkillId: (): Promise<Result<Skill | null, string>> => noop(null),
    list: () => noop([]),
    listVersions: () => noop([]),
    deleteVersion: () => noop(undefined),
    setDisabled: () => noop(undefined),
    deleteSkill: () => noop(undefined),
    listAssigned: () => noop([]),
    assignSkill: () => noop(undefined),
    unassignSkill: () => noop(undefined),
    listAssignments: () => noop([]),
    assignToJob: () => noop(undefined),
    unassignFromJob: () => noop(undefined),
    listAssignmentsForJob: () => noop([]),
    listJobOnlySkillIds: () => noop([]),
  };
  return { adapter, calls };
}

describe("ensureSystemSkills — validating-llm-outputs auto-stamp", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("publishes @friday/validating-llm-outputs with user-invocable: false on a fresh daemon", async () => {
    const { adapter, calls } = mkCapturingAdapter();
    _setSkillStorageForTest(adapter);

    await ensureSystemSkills();

    const stamped = calls.find((c) => c.name === "validating-llm-outputs");
    expect(stamped, "validating-llm-outputs should be auto-stamped").toBeDefined();
    if (!stamped) return;

    // Namespace + createdBy match the system-skill contract enforced
    // by the HTTP write routes (atlasd/routes/skills.ts).
    expect(stamped.namespace).toBe(SYSTEM_SKILL_NAMESPACE);
    expect(stamped.createdBy).toBe(SYSTEM_USER_ID);

    // Frontmatter must carry `user-invocable: false` so
    // `resolveVisibleSkills` excludes it from the workspace catalog
    // (see SkillSummarySchema.userInvocable + E3 fix).
    expect(stamped.input.frontmatter?.["user-invocable"]).toBe(false);

    // `name` and `description` from frontmatter survive the round-trip.
    expect(stamped.input.frontmatter?.name).toBe("validating-llm-outputs");
    expect(typeof stamped.input.frontmatter?.description).toBe("string");

    // Bootstrap injects a content hash so subsequent restarts can
    // skip republish on no-op.
    expect(typeof stamped.input.frontmatter?.["source-hash"]).toBe("string");

    // Body marker — a stable canonical sentence from the bundled
    // SKILL.md. Picked from the FIX-UP RULE section because the
    // surrounding rules are load-bearing for the FSM `validate: self`
    // contract and unlikely to be reworded casually.
    expect(stamped.input.instructions).toContain(
      "If a claim cannot be sourced, drop it from your output.",
    );
  });
});
