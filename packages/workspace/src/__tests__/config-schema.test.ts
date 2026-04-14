import { describe, expect, it } from "vitest";
import {
  ImprovementModeSchema,
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
