import { describe, expect, it, vi } from "vitest";
import { resolveVisibleSkills } from "../src/resolve.ts";
import type { SkillSummary } from "../src/schemas.ts";
import type { SkillStorageAdapter } from "../src/storage.ts";

// =============================================================================
// Helpers
// =============================================================================

function makeSummary(overrides: Partial<SkillSummary> & { skillId: string }): SkillSummary {
  return {
    id: overrides.id ?? overrides.skillId,
    skillId: overrides.skillId,
    namespace: overrides.namespace ?? "atlas",
    name: overrides.name ?? overrides.skillId,
    description: overrides.description ?? `Description for ${overrides.skillId}`,
    disabled: overrides.disabled ?? false,
    latestVersion: overrides.latestVersion ?? 1,
    createdAt: overrides.createdAt ?? new Date("2026-01-01"),
  };
}

function createMockSkillAdapter(
  overrides: Partial<{
    listUnassigned: SkillStorageAdapter["listUnassigned"];
    listAssigned: SkillStorageAdapter["listAssigned"];
    listAssignmentsForJob: SkillStorageAdapter["listAssignmentsForJob"];
  }> = {},
): SkillStorageAdapter {
  return {
    listUnassigned:
      overrides.listUnassigned ??
      vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [] }),
    listAssigned:
      overrides.listAssigned ??
      vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [] }),
    listAssignmentsForJob:
      overrides.listAssignmentsForJob ??
      vi
        .fn<(ws: string, job: string) => ReturnType<SkillStorageAdapter["listAssignmentsForJob"]>>()
        .mockResolvedValue({ ok: true, data: [] }),
    // Unused methods
    create: vi.fn(),
    publish: vi.fn(),
    get: vi.fn(),
    getById: vi.fn(),
    getBySkillId: vi.fn(),
    list: vi.fn(),
    listVersions: vi.fn(),
    deleteVersion: vi.fn(),
    setDisabled: vi.fn(),
    deleteSkill: vi.fn(),
    assignSkill: vi.fn(),
    unassignSkill: vi.fn(),
    listAssignments: vi.fn(),
    assignToJob: vi.fn(),
    unassignFromJob: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("resolveVisibleSkills", () => {
  const WS = "ws-1";

  it("returns unassigned skills when no assignments exist", async () => {
    const skill = makeSummary({ skillId: "sk-global" });
    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [skill] }),
    });

    const result = await resolveVisibleSkills(WS, skills);

    expect(result).toEqual([skill]);
  });

  it("returns union of unassigned + directly assigned", async () => {
    const unassigned = makeSummary({ skillId: "sk-1" });
    const assigned = makeSummary({ skillId: "sk-2" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [unassigned] }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [assigned] }),
    });

    const result = await resolveVisibleSkills(WS, skills);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.skillId)).toEqual(["sk-1", "sk-2"]);
  });

  it("still returns assigned skills when listUnassigned fails", async () => {
    const assigned = makeSummary({ skillId: "sk-assigned" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: false, error: "db error" }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [assigned] }),
    });

    const result = await resolveVisibleSkills(WS, skills);

    expect(result).toEqual([assigned]);
  });

  it("still returns unassigned skills when listAssigned fails", async () => {
    const unassigned = makeSummary({ skillId: "sk-global" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [unassigned] }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: false, error: "db error" }),
    });

    const result = await resolveVisibleSkills(WS, skills);

    expect(result).toEqual([unassigned]);
  });

  it("deduplicates by skillId across the two sources", async () => {
    const skill = makeSummary({ skillId: "sk-overlap" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [skill] }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [skill] }),
    });

    const result = await resolveVisibleSkills(WS, skills);

    expect(result).toHaveLength(1);
    expect(result.at(0)?.skillId).toBe("sk-overlap");
  });

  // ---------------------------------------------------------------------------
  // Job-level layer (additive)
  // ---------------------------------------------------------------------------

  it("does not call listAssignmentsForJob when jobName is omitted", async () => {
    const jobFn = vi
      .fn<(ws: string, job: string) => ReturnType<SkillStorageAdapter["listAssignmentsForJob"]>>()
      .mockResolvedValue({ ok: true, data: [] });
    const skills = createMockSkillAdapter({ listAssignmentsForJob: jobFn });

    await resolveVisibleSkills(WS, skills);

    expect(jobFn).not.toHaveBeenCalled();
  });

  it("unions global + workspace + job-level skills when jobName is set", async () => {
    const globalSkill = makeSummary({ skillId: "sk-global" });
    const wsSkill = makeSummary({ skillId: "sk-ws" });
    const jobSkill = makeSummary({ skillId: "sk-job" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [globalSkill] }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [wsSkill] }),
      listAssignmentsForJob: vi
        .fn<(ws: string, job: string) => ReturnType<SkillStorageAdapter["listAssignmentsForJob"]>>()
        .mockResolvedValue({ ok: true, data: [jobSkill] }),
    });

    const result = await resolveVisibleSkills(WS, skills, { jobName: "daily-summary" });

    expect(result.map((s) => s.skillId).sort()).toEqual(["sk-global", "sk-job", "sk-ws"]);
  });

  it("deduplicates a skill assigned at both workspace and job levels", async () => {
    const shared = makeSummary({ skillId: "sk-shared" });

    const skills = createMockSkillAdapter({
      listUnassigned: vi
        .fn<() => ReturnType<SkillStorageAdapter["listUnassigned"]>>()
        .mockResolvedValue({ ok: true, data: [] }),
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [shared] }),
      listAssignmentsForJob: vi
        .fn<(ws: string, job: string) => ReturnType<SkillStorageAdapter["listAssignmentsForJob"]>>()
        .mockResolvedValue({ ok: true, data: [shared] }),
    });

    const result = await resolveVisibleSkills(WS, skills, { jobName: "x" });

    expect(result).toHaveLength(1);
    expect(result.at(0)?.skillId).toBe("sk-shared");
  });

  it("continues when listAssignmentsForJob fails", async () => {
    const wsSkill = makeSummary({ skillId: "sk-ws" });

    const skills = createMockSkillAdapter({
      listAssigned: vi
        .fn<(ws: string) => ReturnType<SkillStorageAdapter["listAssigned"]>>()
        .mockResolvedValue({ ok: true, data: [wsSkill] }),
      listAssignmentsForJob: vi
        .fn<(ws: string, job: string) => ReturnType<SkillStorageAdapter["listAssignmentsForJob"]>>()
        .mockResolvedValue({ ok: false, error: "db error" }),
    });

    const result = await resolveVisibleSkills(WS, skills, { jobName: "x" });

    expect(result.map((s) => s.skillId)).toEqual(["sk-ws"]);
  });
});
