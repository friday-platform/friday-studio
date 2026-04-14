import { describe, expect, it } from "vitest";
import {
  ImprovementPolicySchema,
  resolveImprovementPolicy,
  type WorkspaceImprovementConfig,
} from "../config-schema.ts";

describe("ImprovementPolicySchema", () => {
  it("accepts 'surface'", () => {
    expect(ImprovementPolicySchema.parse("surface")).toBe("surface");
  });

  it("accepts 'auto'", () => {
    expect(ImprovementPolicySchema.parse("auto")).toBe("auto");
  });

  it("rejects invalid enum values", () => {
    expect(() => ImprovementPolicySchema.parse("manual")).toThrow();
    expect(() => ImprovementPolicySchema.parse("")).toThrow();
    expect(() => ImprovementPolicySchema.parse(42)).toThrow();
  });
});

describe("resolveImprovementPolicy", () => {
  it("defaults to 'surface' when neither workspace nor job flag is set", () => {
    const config: WorkspaceImprovementConfig = {};
    expect(resolveImprovementPolicy(config)).toBe("surface");
  });

  it("defaults to 'surface' when config has no improvement and jobId is provided", () => {
    const config: WorkspaceImprovementConfig = {};
    expect(resolveImprovementPolicy(config, "some-job")).toBe("surface");
  });

  it("uses workspace flag when no job flag is set", () => {
    const config: WorkspaceImprovementConfig = { improvement: "auto" };
    expect(resolveImprovementPolicy(config)).toBe("auto");
  });

  it("uses workspace flag when jobId is provided but job has no override", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "other-job": { improvement: "surface" } },
    };
    expect(resolveImprovementPolicy(config, "missing-job")).toBe("auto");
  });

  it("job flag wins over workspace flag", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "my-job": { improvement: "surface" } },
    };
    expect(resolveImprovementPolicy(config, "my-job")).toBe("surface");
  });

  it("job flag wins even when workspace has no flag", () => {
    const config: WorkspaceImprovementConfig = { jobs: { "my-job": { improvement: "auto" } } };
    expect(resolveImprovementPolicy(config, "my-job")).toBe("auto");
  });

  it("falls back through full chain: job → workspace → default", () => {
    const config: WorkspaceImprovementConfig = {
      improvement: "auto",
      jobs: { "with-override": { improvement: "surface" }, "without-override": {} },
    };

    expect(resolveImprovementPolicy(config, "with-override")).toBe("surface");
    expect(resolveImprovementPolicy(config, "without-override")).toBe("auto");
    expect(resolveImprovementPolicy(config, "nonexistent")).toBe("auto");
    expect(resolveImprovementPolicy(config)).toBe("auto");
  });
});
