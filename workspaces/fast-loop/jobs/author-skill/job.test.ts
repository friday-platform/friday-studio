import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import {
  guard_plan_done,
  guard_publish_done,
  guard_review_approved,
  guard_scaffold_done,
  prepare_plan,
  prepare_publish,
  prepare_review,
  prepare_scaffold,
} from "./job.ts";
import {
  AuthorSkillInputSchema,
  SkillPlanResultSchema,
  SkillPublishResultSchema,
  SkillReviewResultSchema,
  SkillScaffoldResultSchema,
} from "./types.ts";

describe("AuthorSkillInputSchema", () => {
  it("accepts valid payload with request only", () => {
    const result = AuthorSkillInputSchema.safeParse({ request: "Create a Todoist triage skill" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetNamespace).toBe("@tempest");
    }
  });

  it("accepts payload with explicit targetNamespace", () => {
    const result = AuthorSkillInputSchema.safeParse({
      request: "Create a GitHub PR review skill",
      targetNamespace: "@myns",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetNamespace).toBe("@myns");
    }
  });

  it("rejects missing request field", () => {
    const result = AuthorSkillInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty request string", () => {
    const result = AuthorSkillInputSchema.safeParse({ request: "" });
    expect(result.success).toBe(false);
  });
});

describe("SkillPlanResultSchema", () => {
  it("accepts valid plan with all fields", () => {
    const result = SkillPlanResultSchema.safeParse({
      name: "todoist_triage",
      description: "Teaches an agent to triage Todoist tasks by priority and context.",
      instructions_outline: "## Overview\n- Read tasks\n- Categorize by priority",
      reference_files_needed: ["api-reference.md", "examples.md"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects description > 1024 chars", () => {
    const result = SkillPlanResultSchema.safeParse({
      name: "todoist_triage",
      description: "x".repeat(1025),
      instructions_outline: "## Overview",
      reference_files_needed: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = SkillPlanResultSchema.safeParse({
      description: "A skill",
      instructions_outline: "## Overview",
      reference_files_needed: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("SkillScaffoldResultSchema", () => {
  it("accepts valid scaffold with instructions_md and reference_files map", () => {
    const result = SkillScaffoldResultSchema.safeParse({
      name: "todoist_triage",
      instructions_md: "---\nname: todoist_triage\n---\n# Todoist Triage\n\nInstructions here.",
      reference_files: { "api-reference.md": "# API Reference\n\nContent here." },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing instructions_md", () => {
    const result = SkillScaffoldResultSchema.safeParse({
      name: "todoist_triage",
      reference_files: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("SkillReviewResultSchema", () => {
  it("accepts APPROVE verdict with empty findings", () => {
    const result = SkillReviewResultSchema.safeParse({ verdict: "APPROVE", findings: [] });
    expect(result.success).toBe(true);
  });

  it("accepts BLOCK with findings array", () => {
    const result = SkillReviewResultSchema.safeParse({
      verdict: "BLOCK",
      findings: [
        {
          severity: "CRITICAL",
          description: "Missing frontmatter",
          plan_line: "scaffold.instructions_md:frontmatter",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects verdict not in enum", () => {
    const result = SkillReviewResultSchema.safeParse({ verdict: "MAYBE", findings: [] });
    expect(result.success).toBe(false);
  });
});

describe("SkillPublishResultSchema", () => {
  it("accepts valid publish result", () => {
    const result = SkillPublishResultSchema.safeParse({
      published: true,
      version: 1,
      namespace: "@tempest",
      name: "todoist",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-integer version", () => {
    const result = SkillPublishResultSchema.safeParse({
      published: true,
      version: 1.5,
      namespace: "@tempest",
      name: "todoist",
    });
    expect(result.success).toBe(false);
  });
});

describe("workspace.yml integration", () => {
  const workspaceYmlPath = resolve(import.meta.dirname ?? ".", "../../workspace.yml");
  const raw = readFileSync(workspaceYmlPath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;

  it("parses through WorkspaceConfigSchema without errors", () => {
    const result = WorkspaceConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `WorkspaceConfigSchema parse failed: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("has author-skill signal defined", () => {
    const signals = parsed["signals"] as Record<string, unknown>;
    expect(signals["author-skill"]).toBeDefined();
  });

  it("has author-skill job defined", () => {
    const jobs = parsed["jobs"] as Record<string, unknown>;
    expect(jobs["author-skill"]).toBeDefined();
  });
});

describe("FSM shape", () => {
  const workspaceYmlPath = resolve(import.meta.dirname ?? ".", "../../workspace.yml");
  const raw = readFileSync(workspaceYmlPath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  const jobs = parsed["jobs"] as Record<string, Record<string, unknown>>;
  const authorSkillJob = jobs["author-skill"];
  if (!authorSkillJob) throw new Error("author-skill job not found in workspace.yml");
  const fsm = authorSkillJob["fsm"] as Record<string, unknown>;
  const states = fsm["states"] as Record<string, unknown>;

  it("has exactly 6 states", () => {
    const stateNames = Object.keys(states);
    expect(stateNames).toHaveLength(6);
    expect(stateNames.sort()).toEqual(
      ["completed", "idle", "step_plan", "step_publish", "step_review", "step_scaffold"].sort(),
    );
  });

  it("initial state is idle", () => {
    expect(fsm["initial"]).toBe("idle");
  });

  it("completed state is final", () => {
    const completed = states["completed"] as Record<string, unknown>;
    expect(completed["type"]).toBe("final");
  });

  it("idle transitions to step_plan on author-skill event", () => {
    const idle = states["idle"] as Record<string, Record<string, unknown>>;
    const on = idle["on"] as Record<string, Record<string, unknown>>;
    const authorSkillTransition = on["author-skill"];
    expect(authorSkillTransition).toBeDefined();
    if (!authorSkillTransition) throw new Error("author-skill transition not found");
    expect(authorSkillTransition["target"]).toBe("step_plan");
  });
});

describe("guard_review_approved", () => {
  it("returns false when review verdict is BLOCK", () => {
    const context = {
      results: {
        "review-output": {
          verdict: "BLOCK",
          findings: [
            {
              severity: "CRITICAL",
              description: "Missing frontmatter",
              plan_line: "scaffold.instructions_md",
            },
          ],
        },
      },
    };
    expect(guard_review_approved(context, {})).toBe(false);
  });

  it("returns true when review verdict is APPROVE", () => {
    const context = { results: { "review-output": { verdict: "APPROVE", findings: [] } } };
    expect(guard_review_approved(context, {})).toBe(true);
  });

  it("returns false when review output is missing", () => {
    const context = { results: {} };
    expect(guard_review_approved(context, {})).toBe(false);
  });
});

describe("prepare_* functions", () => {
  it("prepare_plan validates signal payload", () => {
    const event = { data: { request: "Create a Todoist triage skill" } };
    const context = { results: {} };
    const result = prepare_plan(context, event);
    expect(result.task).toContain("Todoist triage skill");
    expect(result.config["request"]).toBe("Create a Todoist triage skill");
    expect(result.config["targetNamespace"]).toBe("@tempest");
  });

  it("prepare_plan throws on missing request", () => {
    const event = { data: {} };
    const context = { results: {} };
    expect(() => prepare_plan(context, event)).toThrow();
  });

  it("prepare_scaffold reads plan output", () => {
    const context = {
      results: {
        "plan-output": {
          name: "todoist_triage",
          description: "Triage tasks",
          instructions_outline: "## Overview",
          reference_files_needed: [],
        },
      },
    };
    const result = prepare_scaffold(context, {});
    expect(result.task).toContain("todoist_triage");
    expect(result.config["plan"]).toBeDefined();
  });

  it("prepare_review reads scaffold and plan outputs", () => {
    const context = {
      results: {
        "plan-output": {
          name: "todoist_triage",
          description: "Triage tasks",
          instructions_outline: "## Overview",
          reference_files_needed: [],
        },
        "scaffold-output": {
          name: "todoist_triage",
          instructions_md: "---\nname: todoist_triage\n---\n# Test",
          reference_files: {},
        },
      },
    };
    const result = prepare_review(context, {});
    expect(result.task).toContain("todoist_triage");
    expect(result.config["scaffold"]).toBeDefined();
  });

  it("prepare_publish reads scaffold and plan outputs", () => {
    const context = {
      results: {
        "plan-output": {
          name: "todoist_triage",
          description: "Triage tasks",
          instructions_outline: "## Overview",
          reference_files_needed: [],
        },
        "scaffold-output": {
          name: "todoist_triage",
          instructions_md: "---\nname: todoist_triage\n---\n# Test",
          reference_files: {},
        },
      },
    };
    const result = prepare_publish(context, {});
    expect(result.task).toContain("todoist_triage");
    expect(result.config["scaffold"]).toBeDefined();
    expect(result.config["plan"]).toBeDefined();
  });
});

describe("guard functions", () => {
  it("guard_plan_done returns true when plan-output exists", () => {
    expect(guard_plan_done({ results: { "plan-output": {} } }, {})).toBe(true);
  });

  it("guard_plan_done returns false when plan-output missing", () => {
    expect(guard_plan_done({ results: {} }, {})).toBe(false);
  });

  it("guard_scaffold_done returns true when scaffold-output exists", () => {
    expect(guard_scaffold_done({ results: { "scaffold-output": {} } }, {})).toBe(true);
  });

  it("guard_scaffold_done returns false when scaffold-output missing", () => {
    expect(guard_scaffold_done({ results: {} }, {})).toBe(false);
  });

  it("guard_publish_done returns true when publish-output exists", () => {
    expect(guard_publish_done({ results: { "publish-output": {} } }, {})).toBe(true);
  });

  it("guard_publish_done returns false when publish-output missing", () => {
    expect(guard_publish_done({ results: {} }, {})).toBe(false);
  });
});
