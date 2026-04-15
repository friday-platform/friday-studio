import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import {
  ImprovementModeSchema,
  ImprovementProposalChunkSchema,
  resolveImprovementMode,
  type WorkspaceImprovementConfig,
} from "../config-schema.ts";

describe("ImprovementModeSchema", () => {
  it("accepts 'surface'", () => {
    expect(ImprovementModeSchema.parse("surface")).toBe("surface");
  });

  it("accepts 'auto'", () => {
    expect(ImprovementModeSchema.parse("auto")).toBe("auto");
  });

  it("rejects invalid enum values", () => {
    expect(() => ImprovementModeSchema.parse("manual")).toThrow();
    expect(() => ImprovementModeSchema.parse("")).toThrow();
    expect(() => ImprovementModeSchema.parse(42)).toThrow();
  });
});

describe("WorkspaceConfigSchema — new keys", () => {
  it("accepts corpus_mounts and job-level output keys", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test-workspace" },
      corpus_mounts: [
        { workspace: "thick_endive", corpus: "reflections", kind: "narrative", mode: "read" },
      ],
      jobs: {
        "review-target-workspace": {
          description: "Review target workspace for improvements",
          fsm: { states: {}, initial: "idle" },
          outputs: { corpus: "notes", entryKind: "finding" },
          improvement_key_convention: {
            scoped: "jobs.{target_job_id}.improvement",
            default: "workspace.improvement",
          },
          scope_exclusions: ["skills", "source"],
        },
      },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("accepts corpus_mounts with all four kinds", () => {
    for (const kind of ["narrative", "retrieval", "dedup", "kv"] as const) {
      const fixture = {
        version: "1.0",
        workspace: { name: "test" },
        corpus_mounts: [{ workspace: "ws", corpus: "c", kind, mode: "read" as const }],
      };
      const result = WorkspaceConfigSchema.safeParse(fixture);
      expect(result.success).toBe(true);
    }
  });

  it("accepts corpus_mounts with all three modes", () => {
    for (const mode of ["read", "write", "read_write"] as const) {
      const fixture = {
        version: "1.0",
        workspace: { name: "test" },
        corpus_mounts: [{ workspace: "ws", corpus: "c", kind: "narrative" as const, mode }],
      };
      const result = WorkspaceConfigSchema.safeParse(fixture);
      expect(result.success).toBe(true);
    }
  });

  it("defaults corpus_mounts mode to read when omitted", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      corpus_mounts: [{ workspace: "ws", corpus: "c", kind: "narrative" }],
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.corpus_mounts?.[0]?.mode).toBe("read");
    }
  });

  it("accepts job with outputs {corpus, entryKind}", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: {
        "my-job": {
          fsm: { states: {}, initial: "idle" },
          outputs: { corpus: "notes", entryKind: "finding" },
        },
      },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("accepts job with improvement_key_convention {scoped, default}", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: {
        "my-job": {
          fsm: { states: {}, initial: "idle" },
          improvement_key_convention: {
            scoped: "jobs.{target_job_id}.improvement",
            default: "workspace.improvement",
          },
        },
      },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("accepts job with scope_exclusions string[]", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: {
        "my-job": { fsm: { states: {}, initial: "idle" }, scope_exclusions: ["skills", "source"] },
      },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});

describe("resolveImprovementMode", () => {
  it("defaults to 'surface' when neither workspace nor job flag is set", () => {
    const config: WorkspaceImprovementConfig = {};
    expect(resolveImprovementMode(config)).toBe("surface");
  });

  it("defaults to 'surface' when config has no improvement and jobId is provided", () => {
    const config: WorkspaceImprovementConfig = {};
    expect(resolveImprovementMode(config, "some-job")).toBe("surface");
  });

  it("uses workspace flag when no job flag is set", () => {
    const config: WorkspaceImprovementConfig = { improvement: "auto" };
    expect(resolveImprovementMode(config)).toBe("auto");
  });

  it("uses workspace flag when jobId is provided but job has no override", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "other-job": { improvement: "surface" } },
    };
    expect(resolveImprovementMode(config, "missing-job")).toBe("auto");
  });

  it("job flag wins over workspace flag", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "my-job": { improvement: "surface" } },
    };
    expect(resolveImprovementMode(config, "my-job")).toBe("surface");
  });

  it("job flag wins even when workspace has no flag", () => {
    const config: WorkspaceImprovementConfig = { jobs: { "my-job": { improvement: "auto" } } };
    expect(resolveImprovementMode(config, "my-job")).toBe("auto");
  });

  it("falls back through full chain: job → workspace → default", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "with-override": { improvement: "surface" }, "without-override": {} },
    };

    expect(resolveImprovementMode(config, "with-override")).toBe("surface");
    expect(resolveImprovementMode(config, "without-override")).toBe("auto");
    expect(resolveImprovementMode(config, "nonexistent")).toBe("auto");
    expect(resolveImprovementMode(config)).toBe("auto");
  });
});

describe("WorkspaceConfigSchema — improvement field", () => {
  it("accepts improvement:'surface' at workspace level", () => {
    const fixture = { version: "1.0", workspace: { name: "test" }, improvement: "surface" };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.improvement).toBe("surface");
    }
  });

  it("accepts improvement:'auto' at workspace level", () => {
    const fixture = { version: "1.0", workspace: { name: "test" }, improvement: "auto" };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.improvement).toBe("auto");
    }
  });

  it("defaults improvement to undefined when field absent", () => {
    const fixture = { version: "1.0", workspace: { name: "test" } };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.improvement).toBeUndefined();
    }
  });

  it("rejects improvement:'invalid-value' at workspace level", () => {
    const fixture = { version: "1.0", workspace: { name: "test" }, improvement: "invalid-value" };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it("accepts improvement:'auto' at job level", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: { "my-job": { fsm: { states: {}, initial: "idle" }, improvement: "auto" } },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("accepts improvement:'surface' at job level", () => {
    const fixture = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: { "my-job": { fsm: { states: {}, initial: "idle" }, improvement: "surface" } },
    };
    const result = WorkspaceConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});

describe("ImprovementProposalChunkSchema", () => {
  it("accepts valid improvement-proposal chunk", () => {
    const result = ImprovementProposalChunkSchema.safeParse({
      id: "abc-123",
      kind: "improvement-proposal",
      body: "version: '1.0'\nworkspace:\n  name: test\n",
      createdAt: "2026-04-14T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects chunk with wrong kind", () => {
    const result = ImprovementProposalChunkSchema.safeParse({
      id: "abc-123",
      kind: "something-else",
      body: "content",
      createdAt: "2026-04-14T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("COMPREHENSIVE_ATLAS_EXAMPLE.yml snapshot", () => {
  it("parses without Zod errors after schema change", () => {
    const yamlPath = resolve(
      import.meta.dirname ?? ".",
      "../../../../docs/COMPREHENSIVE_ATLAS_EXAMPLE.yml",
    );
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = parse(raw);
    const result = WorkspaceConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
