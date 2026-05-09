import { describe, expect, it } from "vitest";
import { JobSpecificationSchema } from "./jobs.ts";
import { WorkspaceConfigSchema } from "./workspace.ts";

const minimalWorkspace = {
  version: "1.0" as const,
  workspace: { name: "test", id: "test", description: "test workspace" },
};
const minimalJob = { fsm: { id: "x", initial: "idle", states: { idle: {} } } };

describe("WorkspaceConfigSchema artifacts.default_grace", () => {
  it("accepts a workspace without artifacts (back-compat)", () => {
    const parsed = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(parsed.artifacts).toBeUndefined();
  });

  it("accepts a duration string for default_grace", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      artifacts: { default_grace: "24h" },
    });
    expect(parsed.artifacts?.default_grace).toBe("24h");
  });

  it("accepts a duration in seconds / minutes / hours", () => {
    for (const grace of ["30m", "5s", "1h", "48h"]) {
      const parsed = WorkspaceConfigSchema.parse({
        ...minimalWorkspace,
        artifacts: { default_grace: grace },
      });
      expect(parsed.artifacts?.default_grace).toBe(grace);
    }
  });

  it("rejects a non-duration default_grace", () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ ...minimalWorkspace, artifacts: { default_grace: "garbage" } }),
    ).toThrow();
  });

  it("rejects unknown keys inside artifacts (strict)", () => {
    expect(() =>
      WorkspaceConfigSchema.parse({
        ...minimalWorkspace,
        artifacts: { default_grace: "24h", extra: 1 },
      }),
    ).toThrow();
  });
});

describe("JobSpecificationSchema artifacts.default_grace override", () => {
  it("accepts per-job default_grace", () => {
    const parsed = JobSpecificationSchema.parse({
      ...minimalJob,
      artifacts: { default_grace: "1h" },
    });
    expect(parsed.artifacts?.default_grace).toBe("1h");
  });

  it("accepts per-job ephemeral + default_grace together", () => {
    const parsed = JobSpecificationSchema.parse({
      ...minimalJob,
      artifacts: { ephemeral: false, default_grace: "168h" },
    });
    expect(parsed.artifacts?.ephemeral).toBe(false);
    expect(parsed.artifacts?.default_grace).toBe("168h");
  });

  it("accepts a job with neither field set", () => {
    const parsed = JobSpecificationSchema.parse({ ...minimalJob, artifacts: {} });
    expect(parsed.artifacts).toEqual({});
  });
});
