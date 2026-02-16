import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import type { WorkspaceBlueprint } from "../types.ts";
import { lookupOutputSchema } from "./tools.ts";

// ---------------------------------------------------------------------------
// lookupOutputSchema
// ---------------------------------------------------------------------------

describe("lookupOutputSchema", () => {
  const plan: WorkspaceBlueprint = {
    workspace: { name: "test", purpose: "testing" },
    signals: [],
    agents: [
      {
        id: "data-analyst",
        name: "Data Analyst",
        description: "Analyzes data",
        needs: ["data-analysis"],
      },
      {
        id: "custom-llm",
        name: "Custom Agent",
        description: "Does custom stuff",
        needs: ["custom"],
      },
    ],
    jobs: [
      {
        id: "job-1",
        name: "Test Job",
        title: "Test",
        triggerSignalId: "sig-1",
        steps: [
          {
            id: "step-analyze",
            agentId: "data-analyst",
            description: "Analyze",
            depends_on: [],
            executionType: "bundled",
          },
          {
            id: "step-custom",
            agentId: "custom-llm",
            description: "Custom",
            depends_on: ["step-analyze"],
            executionType: "llm",
          },
        ],
        documentContracts: [],
        prepareMappings: [],
      },
    ],
  };

  it("returns schema from stepOutputSchemas map", () => {
    const customSchema: ValidatedJSONSchema = {
      type: "object",
      properties: { output: { type: "string" } },
    };
    const result = lookupOutputSchema("step-analyze", {
      plan,
      stepOutputSchemas: new Map([["step-analyze", customSchema]]),
    });
    expect(result).toEqual({ schema: customSchema });
  });

  it("returns error for unknown step ID", () => {
    const result = lookupOutputSchema("nonexistent", { plan, stepOutputSchemas: new Map() });
    expect(result).toEqual({ error: 'Step "nonexistent" not found in plan' });
  });

  it("returns error when no schema available for step", () => {
    const result = lookupOutputSchema("step-custom", { plan, stepOutputSchemas: new Map() });
    expect.assert("error" in result);
    expect(result.error).toContain("custom-llm");
  });
});
