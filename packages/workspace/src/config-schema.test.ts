import { describe, expect, it } from "vitest";
import {
  ImprovementPolicyRequestSchema,
  ImprovementPolicySchema,
  JobImprovementConfigSchema,
  resolveImprovementPolicy,
  type WorkspaceImprovementConfig,
  WorkspaceImprovementConfigSchema,
} from "./config-schema.ts";

describe("ImprovementPolicySchema", () => {
  it("accepts 'surface'", () => {
    expect(ImprovementPolicySchema.parse("surface")).toBe("surface");
  });

  it("accepts 'auto'", () => {
    expect(ImprovementPolicySchema.parse("auto")).toBe("auto");
  });

  it("rejects other strings", () => {
    expect(() => ImprovementPolicySchema.parse("manual")).toThrow();
    expect(() => ImprovementPolicySchema.parse("")).toThrow();
  });
});

describe("JobImprovementConfigSchema", () => {
  it("parses job with per-job improvement override", () => {
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

  it("parses config with jobs containing improvement overrides", () => {
    const result = WorkspaceImprovementConfigSchema.parse({
      improvement: "surface",
      jobs: { "nightly-scan": { improvement: "auto" } },
    });
    expect(result.improvement).toBe("surface");
    expect(result.jobs?.["nightly-scan"]?.improvement).toBe("auto");
  });

  it("allows omitting all fields", () => {
    const result = WorkspaceImprovementConfigSchema.parse({});
    expect(result.improvement).toBeUndefined();
    expect(result.jobs).toBeUndefined();
  });
});

describe("ImprovementPolicyRequestSchema", () => {
  it("parses a full request", () => {
    const result = ImprovementPolicyRequestSchema.parse({
      workspaceId: "ws-1",
      jobId: "scan",
      newFullConfig: { improvement: "auto" },
    });
    expect(result.workspaceId).toBe("ws-1");
    expect(result.jobId).toBe("scan");
    expect(result.newFullConfig.improvement).toBe("auto");
  });

  it("allows omitting jobId", () => {
    const result = ImprovementPolicyRequestSchema.parse({ workspaceId: "ws-2", newFullConfig: {} });
    expect(result.jobId).toBeUndefined();
  });
});

describe("resolveImprovementPolicy", () => {
  it("returns 'surface' when both workspace and job fields are absent", () => {
    const cfg: WorkspaceImprovementConfig = {};
    expect(resolveImprovementPolicy(cfg)).toBe("surface");
  });

  it("returns workspace-level value when job field absent", () => {
    const cfg: WorkspaceImprovementConfig = { improvement: "auto" };
    expect(resolveImprovementPolicy(cfg)).toBe("auto");
  });

  it("returns job-level value when set, overriding workspace-level", () => {
    const cfg: WorkspaceImprovementConfig = {
      improvement: "surface",
      jobs: { "my-job": { improvement: "auto" } },
    };
    expect(resolveImprovementPolicy(cfg, "my-job")).toBe("auto");
  });

  it("returns 'surface' default when workspace field is 'surface' and job is absent", () => {
    const cfg: WorkspaceImprovementConfig = { improvement: "surface" };
    expect(resolveImprovementPolicy(cfg, "nonexistent")).toBe("surface");
  });

  it("unknown jobId falls back to workspace flag then 'surface'", () => {
    const cfg: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "known-job": { improvement: "surface" } },
    };
    expect(resolveImprovementPolicy(cfg, "unknown-job")).toBe("auto");
    expect(resolveImprovementPolicy(cfg)).toBe("auto");
  });

  it("falls back to 'surface' when workspace is undefined and job has no override", () => {
    const cfg: WorkspaceImprovementConfig = { jobs: { "my-job": {} } };
    expect(resolveImprovementPolicy(cfg, "my-job")).toBe("surface");
  });
});
