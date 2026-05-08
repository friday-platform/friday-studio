import { describe, expect, it } from "vitest";
import { JobSpecificationSchema } from "./jobs.ts";
import {
  DEFAULT_VALIDATION_SKILL,
  normalizeActionValidate,
  resolveValidation,
  ValidationDefaultsSchema,
} from "./validation.ts";
import { WorkspaceConfigSchema } from "./workspace.ts";

describe("resolveValidation — strategy precedence", () => {
  it("returns 'auto' + default skill when nothing is set", () => {
    expect(resolveValidation({})).toEqual({ strategy: "auto", skill: DEFAULT_VALIDATION_SKILL });
  });

  it("workspace default wins over the implicit auto", () => {
    expect(resolveValidation({ workspace: { default: "external" } })).toEqual({
      strategy: "external",
      skill: DEFAULT_VALIDATION_SKILL,
    });
  });

  it("job default wins over workspace default", () => {
    const r = resolveValidation({ job: { default: "skip" }, workspace: { default: "external" } });
    expect(r.strategy).toBe("skip");
  });

  it("action wins over job + workspace", () => {
    const r = resolveValidation({
      action: { strategy: "self" },
      job: { default: "skip" },
      workspace: { default: "external" },
    });
    expect(r.strategy).toBe("self");
  });

  it("undefined fields fall through (not treated as 'auto')", () => {
    // Job sets only skill; strategy should still come from workspace.
    const r = resolveValidation({
      job: { skill: "@my/skill" },
      workspace: { default: "external" },
    });
    expect(r.strategy).toBe("external");
  });
});

describe("resolveValidation — skill precedence", () => {
  it("falls back to DEFAULT_VALIDATION_SKILL when nothing is set", () => {
    expect(resolveValidation({}).skill).toBe(DEFAULT_VALIDATION_SKILL);
  });

  it("workspace skill wins over default", () => {
    expect(resolveValidation({ workspace: { skill: "@ws/skill" } }).skill).toBe("@ws/skill");
  });

  it("job skill wins over workspace skill", () => {
    expect(
      resolveValidation({ job: { skill: "@job/skill" }, workspace: { skill: "@ws/skill" } }).skill,
    ).toBe("@job/skill");
  });

  it("action skill wins over job + workspace", () => {
    expect(
      resolveValidation({
        action: { skill: "@action/skill" },
        job: { skill: "@job/skill" },
        workspace: { skill: "@ws/skill" },
      }).skill,
    ).toBe("@action/skill");
  });
});

describe("ValidationDefaultsSchema", () => {
  it("parses a complete valid block", () => {
    const parsed = ValidationDefaultsSchema.parse({ default: "external", skill: "@my/judge" });
    expect(parsed).toEqual({ default: "external", skill: "@my/judge" });
  });

  it("parses an empty object", () => {
    expect(ValidationDefaultsSchema.parse({})).toEqual({});
  });

  it("accepts every valid strategy", () => {
    for (const d of ["auto", "skip", "self", "external"] as const) {
      expect(ValidationDefaultsSchema.parse({ default: d })).toEqual({ default: d });
    }
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => ValidationDefaultsSchema.parse({ default: "auto", surprise: 1 })).toThrow();
  });

  it("rejects an unknown default value", () => {
    expect(() => ValidationDefaultsSchema.parse({ default: "wrong" })).toThrow();
  });
});

describe("normalizeActionValidate", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeActionValidate(undefined)).toBeUndefined();
  });

  it("normalizes the string form", () => {
    expect(normalizeActionValidate("skip")).toEqual({ strategy: "skip" });
    expect(normalizeActionValidate("auto")).toEqual({ strategy: "auto" });
  });

  it("normalizes the object form", () => {
    expect(normalizeActionValidate({ strategy: "self", skill: "@x/y" })).toEqual({
      strategy: "self",
      skill: "@x/y",
    });
  });

  it("omits skill when the object form doesn't set it", () => {
    expect(normalizeActionValidate({ strategy: "external" })).toEqual({ strategy: "external" });
  });
});

describe("WorkspaceConfigSchema with validation block", () => {
  const minimalWorkspace = {
    version: "1.0" as const,
    workspace: { name: "test", id: "test", description: "test workspace" },
  };

  it("accepts a workspace without a validation block (back-compat)", () => {
    const parsed = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(parsed.validation).toBeUndefined();
  });

  it("accepts a workspace with validation defaults", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      validation: { default: "external", skill: "@my/judge" },
    });
    expect(parsed.validation).toEqual({ default: "external", skill: "@my/judge" });
  });

  it("rejects an unknown key inside validation", () => {
    expect(() =>
      WorkspaceConfigSchema.parse({
        ...minimalWorkspace,
        validation: { default: "auto", surprise: 1 },
      }),
    ).toThrow();
  });
});

describe("JobSpecificationSchema with per-job validation", () => {
  const minimalJob = { fsm: { id: "x", initial: "idle", states: { idle: {} } } };

  it("accepts a job without a validation block (inherits workspace)", () => {
    const parsed = JobSpecificationSchema.parse(minimalJob);
    expect(parsed.validation).toBeUndefined();
  });

  it("accepts a job with validation defaults", () => {
    const parsed = JobSpecificationSchema.parse({ ...minimalJob, validation: { default: "skip" } });
    expect(parsed.validation).toEqual({ default: "skip" });
  });

  it("rejects an unknown key inside validation", () => {
    expect(() =>
      JobSpecificationSchema.parse({ ...minimalJob, validation: { unknown: 1 } }),
    ).toThrow();
  });
});
