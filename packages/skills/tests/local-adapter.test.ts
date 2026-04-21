import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillAdapter } from "../src/local-adapter.ts";
import { toSlug } from "../src/slug.ts";

describe("LocalSkillAdapter", () => {
  let adapter: LocalSkillAdapter;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `skills-test-${Date.now()}.db`);
    adapter = new LocalSkillAdapter(dbPath);
  });

  afterEach(() => {
    try {
      rmSync(dbPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe("publish", () => {
    it("publishes a skill with version 1", async () => {
      const result = await adapter.publish("atlas", "code-review", "user-1", {
        description: "Reviews code",
        instructions: "Review the code.",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.version).toBe(1);
      expect(result.data.id).toBeTruthy();
    });

    it("auto-increments version on republish", async () => {
      await adapter.publish("atlas", "code-review", "user-1", {
        description: "v1",
        instructions: "First version.",
      });
      const v2 = await adapter.publish("atlas", "code-review", "user-1", {
        description: "v2",
        instructions: "Second version.",
      });
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.data.version).toBe(2);

      const v3 = await adapter.publish("atlas", "code-review", "user-1", {
        description: "v3",
        instructions: "Third version.",
      });
      expect(v3.ok).toBe(true);
      if (!v3.ok) return;
      expect(v3.data.version).toBe(3);
    });

    it("versions are independent per namespace+name", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", { description: "A", instructions: "." });
      const b = await adapter.publish("atlas", "skill-b", "user-1", {
        description: "B",
        instructions: ".",
      });
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.data.version).toBe(1);
    });

    it("stores frontmatter when provided", async () => {
      await adapter.publish("atlas", "with-fm", "user-1", {
        description: "Has frontmatter",
        instructions: "Do things.",
        frontmatter: { "allowed-tools": "Read, Grep", context: "fork" },
      });
      const result = await adapter.get("atlas", "with-fm");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.frontmatter["allowed-tools"]).toBe("Read, Grep");
    });

    it("stores archive when provided", async () => {
      const archive = new Uint8Array([1, 2, 3, 4]);
      await adapter.publish("atlas", "with-archive", "user-1", {
        description: "Has archive",
        instructions: ".",
        archive,
      });
      const result = await adapter.get("atlas", "with-archive");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.archive).toEqual(archive);
    });
  });

  describe("get", () => {
    it("returns latest version when version omitted", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });
      const result = await adapter.get("atlas", "my-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(2);
      expect(result.data?.description).toBe("v2");
    });

    it("returns specific version when provided", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });
      const result = await adapter.get("atlas", "my-skill", 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(1);
      expect(result.data?.description).toBe("v1");
    });

    it("returns null for nonexistent skill", async () => {
      const result = await adapter.get("atlas", "missing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });

    it("returns null for nonexistent version", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      const result = await adapter.get("atlas", "my-skill", 99);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });
  });

  describe("list", () => {
    it("returns one summary per namespace+name with latest version", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", {
        description: "A v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "skill-a", "user-1", {
        description: "A v2",
        instructions: ".",
      });
      await adapter.publish("atlas", "skill-b", "user-1", { description: "B", instructions: "." });
      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(2);
      const a = result.data.find((s) => s.name === "skill-a");
      expect(a?.latestVersion).toBe(2);
      expect(a?.description).toBe("A v2");
    });

    it("filters by namespace", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", { description: "A", instructions: "." });
      await adapter.publish("acme", "skill-b", "user-1", { description: "B", instructions: "." });
      const result = await adapter.list("atlas");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.namespace).toBe("atlas");
    });

    it("filters by query text", async () => {
      await adapter.publish("atlas", "code-review", "user-1", {
        description: "Reviews code for issues",
        instructions: ".",
      });
      await adapter.publish("atlas", "deploy", "user-1", {
        description: "Deploys stuff",
        instructions: ".",
      });
      const result = await adapter.list(undefined, "review");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.name).toBe("code-review");
    });
  });

  describe("getById", () => {
    it("returns the skill by id", async () => {
      const pub = await adapter.publish("atlas", "by-id-test", "user-1", {
        description: "Findable",
        instructions: "Find me.",
      });
      expect(pub.ok).toBe(true);
      if (!pub.ok) return;

      const result = await adapter.getById(pub.data.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).not.toBeNull();
      expect(result.data?.id).toBe(pub.data.id);
      expect(result.data?.namespace).toBe("atlas");
      expect(result.data?.name).toBe("by-id-test");
      expect(result.data?.description).toBe("Findable");
    });

    it("returns null for nonexistent id", async () => {
      const result = await adapter.getById("nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeNull();
    });
  });

  describe("list summaries", () => {
    it("includes id in list summaries", async () => {
      await adapter.publish("atlas", "listed-id", "user-1", {
        description: "Check id",
        instructions: ".",
      });
      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const skill = result.data.find((s) => s.name === "listed-id");
      expect(skill?.id).toBeTruthy();
    });
  });

  describe("listVersions", () => {
    it("returns all versions sorted descending", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-2", {
        description: "v2",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v3",
        instructions: ".",
      });
      const result = await adapter.listVersions("atlas", "my-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(3);
      expect(result.data[0]?.version).toBe(3);
      expect(result.data[1]?.version).toBe(2);
      expect(result.data[2]?.version).toBe(1);
      expect(result.data[1]?.createdBy).toBe("user-2");
    });

    it("returns empty array for nonexistent skill", async () => {
      const result = await adapter.listVersions("atlas", "missing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });

  describe("deleteVersion", () => {
    it("removes a specific version", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: ".",
      });

      const del = await adapter.deleteVersion("atlas", "my-skill", 1);
      expect(del.ok).toBe(true);

      const v1 = await adapter.get("atlas", "my-skill", 1);
      expect(v1.ok).toBe(true);
      if (!v1.ok) return;
      expect(v1.data).toBe(null);

      // v2 still exists
      const v2 = await adapter.get("atlas", "my-skill", 2);
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.data?.version).toBe(2);
    });

    it("does not error when deleting nonexistent version", async () => {
      const result = await adapter.deleteVersion("atlas", "missing", 1);
      expect(result.ok).toBe(true);
    });
  });

  describe("toSlug", () => {
    const cases = [
      { name: "basic title", input: "My Cool Skill", expected: "my-cool-skill" },
      { name: "extra whitespace", input: "  hello   world  ", expected: "hello-world" },
      { name: "special characters", input: "skill@v2.0!", expected: "skill-v2-0" },
      { name: "leading/trailing hyphens", input: "---hello---", expected: "hello" },
      { name: "already a slug", input: "my-skill", expected: "my-skill" },
    ] as const;

    it.each(cases)("$name: $input -> $expected", ({ input, expected }) => {
      expect(toSlug(input)).toBe(expected);
    });
  });

  describe("publish returns name", () => {
    it("return value includes name field", async () => {
      const result = await adapter.publish("atlas", "test-skill", "user-1", {
        description: "Has name in response",
        instructions: ".",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.name).toBe("test-skill");
    });

    it("return value includes skillId", async () => {
      const result = await adapter.publish("atlas", "test-skill", "user-1", {
        description: "Has skillId",
        instructions: ".",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.skillId).toBeTruthy();
    });
  });

  describe("create", () => {
    it("creates a draft skill with null name", async () => {
      const result = await adapter.create("atlas", "user-1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.skillId).toBeTruthy();

      const skill = await adapter.getBySkillId(result.data.skillId);
      expect(skill.ok).toBe(true);
      if (!skill.ok) return;
      expect(skill.data).not.toBeNull();
      expect(skill.data?.name).toBeNull();
      expect(skill.data?.description).toBe("");
      expect(skill.data?.instructions).toBe("");
      expect(skill.data?.version).toBe(1);
    });
  });

  describe("getBySkillId", () => {
    it("returns latest version for a skillId", async () => {
      const pub1 = await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      expect(pub1.ok).toBe(true);
      if (!pub1.ok) return;

      const pub2 = await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
        skillId: pub1.data.skillId,
      });
      expect(pub2.ok).toBe(true);
      if (!pub2.ok) return;

      const result = await adapter.getBySkillId(pub1.data.skillId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(2);
      expect(result.data?.description).toBe("v2");
    });

    it("returns null for non-existent skillId", async () => {
      const result = await adapter.getBySkillId("nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeNull();
    });
  });

  describe("skillId versioning", () => {
    it("versions share the same skillId when published with skillId", async () => {
      const pub1 = await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      expect(pub1.ok).toBe(true);
      if (!pub1.ok) return;

      const pub2 = await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: ".",
        skillId: pub1.data.skillId,
      });
      expect(pub2.ok).toBe(true);
      if (!pub2.ok) return;

      expect(pub2.data.skillId).toBe(pub1.data.skillId);
      expect(pub2.data.version).toBe(2);
    });

    it("rename via publish updates all versions with same skillId", async () => {
      const pub1 = await adapter.publish("atlas", "old-name", "user-1", {
        description: "v1",
        instructions: ".",
      });
      expect(pub1.ok).toBe(true);
      if (!pub1.ok) return;

      await adapter.publish("atlas", "new-name", "user-1", {
        description: "v2",
        instructions: ".",
        skillId: pub1.data.skillId,
      });

      // Old version should now have the new name
      const v1 = await adapter.getById(pub1.data.id);
      expect(v1.ok).toBe(true);
      if (!v1.ok) return;
      expect(v1.data?.name).toBe("new-name");
    });

    it("create then publish links versions via skillId", async () => {
      const created = await adapter.create("atlas", "user-1");
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const pub = await adapter.publish("atlas", "my-skill", "user-1", {
        description: "Published",
        instructions: "Do things.",
        skillId: created.data.skillId,
      });
      expect(pub.ok).toBe(true);
      if (!pub.ok) return;
      expect(pub.data.skillId).toBe(created.data.skillId);
      expect(pub.data.version).toBe(2); // draft was version 1

      const latest = await adapter.getBySkillId(created.data.skillId);
      expect(latest.ok).toBe(true);
      if (!latest.ok) return;
      expect(latest.data?.name).toBe("my-skill");
      expect(latest.data?.description).toBe("Published");
    });
  });

  describe("list includeAll", () => {
    it("excludes null-name skills by default", async () => {
      await adapter.create("atlas", "user-1");
      await adapter.publish("atlas", "real-skill", "user-1", {
        description: "Visible",
        instructions: ".",
      });
      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.name).toBe("real-skill");
    });

    it("excludes empty-description skills by default", async () => {
      await adapter.publish("atlas", "no-desc", "user-1", { instructions: "." });
      await adapter.publish("atlas", "has-desc", "user-1", {
        description: "Present",
        instructions: ".",
      });
      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.name).toBe("has-desc");
    });

    it("includes all skills when includeAll is true", async () => {
      await adapter.create("atlas", "user-1");
      await adapter.publish("atlas", "real-skill", "user-1", {
        description: "Visible",
        instructions: ".",
      });
      const result = await adapter.list(undefined, undefined, true);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(2);
    });

    it("list summaries include skillId", async () => {
      const pub = await adapter.publish("atlas", "listed-skill", "user-1", {
        description: "Check skillId",
        instructions: ".",
      });
      expect(pub.ok).toBe(true);
      if (!pub.ok) return;

      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const skill = result.data.find((s) => s.name === "listed-skill");
      expect(skill?.skillId).toBe(pub.data.skillId);
    });
  });

  describe("descriptionManual", () => {
    it("defaults to false", async () => {
      await adapter.publish("atlas", "auto-desc", "user-1", {
        description: "Auto",
        instructions: ".",
      });
      const result = await adapter.get("atlas", "auto-desc");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.descriptionManual).toBe(false);
    });

    it("preserves true when set", async () => {
      await adapter.publish("atlas", "manual-desc", "user-1", {
        description: "Manual",
        instructions: ".",
        descriptionManual: true,
      });
      const result = await adapter.get("atlas", "manual-desc");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.descriptionManual).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Job-level assignments (PR #2 Phase B)
  // ---------------------------------------------------------------------------

  describe("job-level assignments", () => {
    async function seedSkill(name: string): Promise<string> {
      const result = await adapter.publish("team", name, "u", {
        description: `Skill ${name}`,
        instructions: ".",
      });
      if (!result.ok) throw new Error(`seed failed: ${result.error}`);
      return result.data.skillId;
    }

    it("assignToJob adds a job-level row (workspace-level rows unaffected)", async () => {
      const skillId = await seedSkill("only-me");

      await adapter.assignSkill(skillId, "ws-1"); // workspace-level
      await adapter.assignToJob(skillId, "ws-1", "job-a");

      // Workspace-level listing still sees the workspace row
      const ws = await adapter.listAssigned("ws-1");
      expect(ws.ok && ws.data.some((s) => s.skillId === skillId)).toBe(true);

      // Job-level listing sees the job row
      const job = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(job.ok && job.data.some((s) => s.skillId === skillId)).toBe(true);
    });

    it("listAssignmentsForJob does not leak other jobs' rows", async () => {
      const a = await seedSkill("a-only");
      const b = await seedSkill("b-only");

      await adapter.assignToJob(a, "ws-1", "job-a");
      await adapter.assignToJob(b, "ws-1", "job-b");

      const forA = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(forA.ok).toBe(true);
      if (!forA.ok) return;
      expect(forA.data.map((s) => s.skillId)).toEqual([a]);

      const forB = await adapter.listAssignmentsForJob("ws-1", "job-b");
      expect(forB.ok).toBe(true);
      if (!forB.ok) return;
      expect(forB.data.map((s) => s.skillId)).toEqual([b]);
    });

    it("listAssigned (workspace-level) ignores job-level rows", async () => {
      // A.1.5 query audit regression: listAssigned used to leak job rows.
      const skillId = await seedSkill("job-only");
      await adapter.assignToJob(skillId, "ws-1", "job-a");

      const ws = await adapter.listAssigned("ws-1");
      expect(ws.ok).toBe(true);
      if (!ws.ok) return;
      expect(ws.data.some((s) => s.skillId === skillId)).toBe(false);
    });

    it("unassignSkill (workspace-level) leaves job-level rows intact", async () => {
      // A.1.5 query audit regression: unassignSkill used to nuke job rows.
      const skillId = await seedSkill("keep-job-row");

      await adapter.assignSkill(skillId, "ws-1");
      await adapter.assignToJob(skillId, "ws-1", "job-a");

      await adapter.unassignSkill(skillId, "ws-1");

      const ws = await adapter.listAssigned("ws-1");
      expect(ws.ok && ws.data.some((s) => s.skillId === skillId)).toBe(false);

      const job = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(job.ok && job.data.some((s) => s.skillId === skillId)).toBe(true);
    });

    it("unassignFromJob removes a specific job row only", async () => {
      const skillId = await seedSkill("dual-job");
      await adapter.assignToJob(skillId, "ws-1", "job-a");
      await adapter.assignToJob(skillId, "ws-1", "job-b");

      await adapter.unassignFromJob(skillId, "ws-1", "job-a");

      const a = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(a.ok && a.data.some((s) => s.skillId === skillId)).toBe(false);

      const b = await adapter.listAssignmentsForJob("ws-1", "job-b");
      expect(b.ok && b.data.some((s) => s.skillId === skillId)).toBe(true);
    });

    it("listAssignments returns DISTINCT workspace ids across mixed layers", async () => {
      // A.1.5 regression: dual workspace+job rows used to duplicate in output.
      const skillId = await seedSkill("mixed");
      await adapter.assignSkill(skillId, "ws-1");
      await adapter.assignToJob(skillId, "ws-1", "job-a");
      await adapter.assignToJob(skillId, "ws-1", "job-b");

      const assignments = await adapter.listAssignments(skillId);
      expect(assignments.ok).toBe(true);
      if (!assignments.ok) return;
      expect(assignments.data).toEqual(["ws-1"]);
    });

    it("assignSkill is idempotent at the workspace level", async () => {
      // The partial unique index on (skill_id, workspace_id) WHERE job_name
      // IS NULL prevents duplicate workspace rows even across INSERT OR
      // IGNORE races.
      const skillId = await seedSkill("idempotent-ws");

      const first = await adapter.assignSkill(skillId, "ws-1");
      const second = await adapter.assignSkill(skillId, "ws-1");
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      const assignments = await adapter.listAssignments(skillId);
      expect(assignments.ok).toBe(true);
      if (!assignments.ok) return;
      expect(assignments.data).toEqual(["ws-1"]);
    });

    it("assignToJob is idempotent for the same (ws, job)", async () => {
      const skillId = await seedSkill("idempotent-job");
      const first = await adapter.assignToJob(skillId, "ws-1", "job-a");
      const second = await adapter.assignToJob(skillId, "ws-1", "job-a");
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      const job = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(job.ok).toBe(true);
      if (!job.ok) return;
      const count = job.data.filter((s) => s.skillId === skillId).length;
      expect(count).toBe(1);
    });

    it("deleteSkill removes workspace AND job rows", async () => {
      const skillId = await seedSkill("delete-me");
      await adapter.assignSkill(skillId, "ws-1");
      await adapter.assignToJob(skillId, "ws-1", "job-a");

      await adapter.deleteSkill(skillId);

      const ws = await adapter.listAssigned("ws-1");
      expect(ws.ok && ws.data.some((s) => s.skillId === skillId)).toBe(false);
      const job = await adapter.listAssignmentsForJob("ws-1", "job-a");
      expect(job.ok && job.data.some((s) => s.skillId === skillId)).toBe(false);
    });
  });
});
