import { describe, expect, it } from "vitest";
import { ClassifiedDAGStepSchema } from "./workspace.ts";

describe("ClassifiedDAGStepSchema", () => {
  it("backfills executionRef from agentId when missing (v2 migration)", () => {
    const result = ClassifiedDAGStepSchema.parse({
      id: "step-1",
      agentId: "email",
      description: "Send an email",
      depends_on: [],
      executionType: "bundled" as const,
      tools: ["send-email"],
    });

    expect(result.executionRef).toBe("email");
    expect(result.agentId).toBe("email");
  });
});
