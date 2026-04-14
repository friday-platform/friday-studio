import { describe, expect, it } from "vitest";
import {
  ImprovementModeRequestSchema,
  ImprovementModeSchema,
  JobImprovementConfigSchema,
  resolveImprovementMode,
  type WorkspaceImprovementConfig,
  WorkspaceImprovementConfigSchema,
} from "./config-schema.ts";

describe("ImprovementModeSchema", () => {
  it("accepts 'surface'", () => {
    expect(ImprovementModeSchema.parse("surface")).toBe("surface");
  });

  it("accepts 'auto'", () => {
    expect(ImprovementModeSchema.parse("auto")).toBe("auto");
  });

  it("rejects other strings", () => {
    expect(() => ImprovementModeSchema.parse("manual")).toThrow();
    expect(() => ImprovementModeSchema.parse("")).toThrow();
  });

  it("rejects non-string values", () => {
    expect(() => ImprovementModeSchema.parse(42)).toThrow();
  });
});

describe("JobImprovementConfigSchema", () => {
  it("parses job with improvement: 'auto'", () => {
    const result = JobImprovementConfigSchema.parse({ improvement: "auto" });
    expect(result.improvement).toBe("auto");
  });

  it("allows omitting improvement field", () => {
    const result = JobImprovementConfigSchema.parse({});
    expect(result.improvement).toBeUndefined();
  });
});

describe("WorkspaceImprovementConfigSchema", () => {
  it("parses config with top-level improvement field", () => {
    const result = WorkspaceImprovementConfigSchema.parse({ improvement: "auto" });
    expect(result.improvement).toBe("auto");
  });

  it("parses with improvement omitted (defaults undefined, resolves to surface)", () => {
    const result = WorkspaceImprovementConfigSchema.parse({});
    expect(result.improvement).toBeUndefined();
    expect(resolveImprovementMode(result)).toBe("surface");
  });

  it("parses config with jobs containing improvement overrides", () => {
    const result = WorkspaceImprovementConfigSchema.parse({
      improvement: "surface",
      jobs: { "nightly-scan": { improvement: "auto" } },
    });
    expect(result.improvement).toBe("surface");
    expect(result.jobs?.["nightly-scan"]?.improvement).toBe("auto");
  });
});

describe("ImprovementModeRequestSchema", () => {
  it("parses a full request", () => {
    const result = ImprovementModeRequestSchema.parse({
      workspaceId: "ws-1",
      jobId: "scan",
      newFullConfig: { improvement: "auto" },
    });
    expect(result.workspaceId).toBe("ws-1");
    expect(result.jobId).toBe("scan");
    expect(result.newFullConfig.improvement).toBe("auto");
  });

  it("allows omitting jobId", () => {
    const result = ImprovementModeRequestSchema.parse({ workspaceId: "ws-2", newFullConfig: {} });
    expect(result.jobId).toBeUndefined();
  });
});

describe("resolveImprovementMode", () => {
  it("returns 'surface' when no flags set anywhere", () => {
    const cfg: WorkspaceImprovementConfig = {};
    expect(resolveImprovementMode(cfg)).toBe("surface");
  });

  it("returns workspace-level flag when job has none", () => {
    const cfg: WorkspaceImprovementConfig = { improvement: "auto" };
    expect(resolveImprovementMode(cfg)).toBe("auto");
  });

  it("returns job-level flag when set, ignoring workspace flag", () => {
    const cfg: WorkspaceImprovementConfig = {
      improvement: "surface",
      jobs: { "my-job": { improvement: "auto" } },
    };
    expect(resolveImprovementMode(cfg, "my-job")).toBe("auto");
  });

  it("correctly handles jobId that does not exist in cfg.jobs", () => {
    const cfg: WorkspaceImprovementConfig = { improvement: "surface" };
    expect(resolveImprovementMode(cfg, "nonexistent")).toBe("surface");
  });

  it("unknown jobId falls back to workspace flag then 'surface'", () => {
    const cfg: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "known-job": { improvement: "surface" } },
    };
    expect(resolveImprovementMode(cfg, "unknown-job")).toBe("auto");
    expect(resolveImprovementMode(cfg)).toBe("auto");
  });

  it("falls back to 'surface' when workspace is undefined and job has no override", () => {
    const cfg: WorkspaceImprovementConfig = { jobs: { "my-job": {} } };
    expect(resolveImprovementMode(cfg, "my-job")).toBe("surface");
  });
});
