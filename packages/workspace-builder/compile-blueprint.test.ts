import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { describe, expect, it } from "vitest";
import { compileBlueprint } from "./compile-blueprint.ts";
import type { WorkspaceBlueprint } from "./types.ts";
import { WorkspaceBlueprintSchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function loadFixturePlan(name: string): WorkspaceBlueprint {
  const dirname = import.meta.dirname;
  if (!dirname) throw new Error("import.meta.dirname is undefined");
  const fixturePath = resolve(dirname, "fixtures", `${name}.json`);
  return WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("compileBlueprint", () => {
  it("compiles a linear pipeline fixture", () => {
    const blueprint = loadFixturePlan("csv-analysis-plan");
    const result = compileBlueprint(blueprint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.yaml).toBeTruthy();
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
  });

  it("compiles an email-inbox-summary fixture", () => {
    const blueprint = loadFixturePlan("email-inbox-summary");
    const result = compileBlueprint(blueprint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.yaml).toContain("signals:");
  });

  it("returns ok: false when compilation produces warnings", () => {
    // fan-in-plan triggers compiler warnings (missing document contract matches)
    // which compileBlueprint treats as errors
    const blueprint = loadFixturePlan("fan-in-plan");
    const result = compileBlueprint(blueprint);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Compiler warnings");
  });

  // ---------------------------------------------------------------------------
  // Multi-job
  // ---------------------------------------------------------------------------

  it("compiles a multi-job blueprint", () => {
    const blueprint = loadFixturePlan("multi-job-plan");
    const result = compileBlueprint(blueprint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.yaml).toBeTruthy();
    // Multi-job should produce valid YAML with multiple FSM states
    expect(result.yaml.length).toBeGreaterThan(100);
  });

  // ---------------------------------------------------------------------------
  // With dynamic MCP servers
  // ---------------------------------------------------------------------------

  it("compiles with dynamic MCP servers passed through", () => {
    const blueprint = loadFixturePlan("csv-analysis-plan");
    const dynamicServers: MCPServerMetadata[] = [
      {
        id: "test-server",
        name: "Test MCP Server",
        description: "A test server",
        securityRating: "medium",
        source: "static",
        configTemplate: { transport: { type: "stdio", command: "echo", args: [] } },
      },
    ];

    const result = compileBlueprint(blueprint, dynamicServers);
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Conditional blueprint
  // ---------------------------------------------------------------------------

  it("compiles a blueprint with conditionals", () => {
    const blueprint = loadFixturePlan("conditional-error-triage");
    const result = compileBlueprint(blueprint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.yaml).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  it("returns ok: false for a job with duplicate step IDs", () => {
    const blueprint = loadFixturePlan("csv-analysis-plan");

    // Create a blueprint where two steps share the same ID — causes
    // topological sort / FSM build to fail
    const corruptedBlueprint: WorkspaceBlueprint = {
      ...blueprint,
      jobs: blueprint.jobs.map((job) => ({
        ...job,
        steps: job.steps.map((step) => ({ ...step, id: "duplicate-id" })),
      })),
    };

    const result = compileBlueprint(corruptedBlueprint);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  it("returns ok: true for a blueprint with empty jobs array", () => {
    const blueprint = loadFixturePlan("csv-analysis-plan");

    const emptyJobsBlueprint: WorkspaceBlueprint = { ...blueprint, jobs: [] };

    const result = compileBlueprint(emptyJobsBlueprint);
    // Empty jobs should still compile — just produces minimal YAML
    expect(result.ok).toBe(true);
  });
});
