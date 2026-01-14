import type { WorkspacePlan } from "@atlas/core/artifacts";
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { classifyAgents } from "./agent-classifier.ts";

describe("classifyAgents", () => {
  it("classifies agent with exact capability match as bundled", () => {
    const plan: WorkspacePlan = {
      workspace: { name: "test", purpose: "test" },
      signals: [],
      agents: [
        { id: "test-email", name: "Email Agent", description: "Send email", needs: ["email"] },
      ],
      jobs: [],
    };

    const classified = classifyAgents(plan);

    assertEquals(classified.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    const first = classified[0]!;
    assertEquals(first.type.kind, "bundled");
    if (first.type.kind === "bundled") {
      assertEquals(first.type.bundledId, "email");
    }
  });

  it("classifies agent with verbose need containing capability as bundled", () => {
    // This is the bug case: "html-email" should match "email" bundled agent
    const plan: WorkspacePlan = {
      workspace: { name: "test", purpose: "test" },
      signals: [],
      agents: [
        {
          id: "email-formatter",
          name: "Email Formatter",
          description: "Format and send HTML email",
          needs: ["html-email"],
        },
      ],
      jobs: [],
    };

    const classified = classifyAgents(plan);

    assertEquals(classified.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    const first = classified[0]!;
    assertEquals(first.type.kind, "bundled", "html-email should match email agent");
    if (first.type.kind === "bundled") {
      assertEquals(first.type.bundledId, "email");
    }
  });

  it("classifies agent with email-formatting need as bundled", () => {
    const plan: WorkspacePlan = {
      workspace: { name: "test", purpose: "test" },
      signals: [],
      agents: [
        {
          id: "formatter",
          name: "Formatter",
          description: "Format email",
          needs: ["email-formatting"],
        },
      ],
      jobs: [],
    };

    const classified = classifyAgents(plan);

    assertEquals(classified.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    const first = classified[0]!;
    assertEquals(first.type.kind, "bundled", "email-formatting should match email agent");
  });

  it("classifies agent with no matching capability as llm", () => {
    const plan: WorkspacePlan = {
      workspace: { name: "test", purpose: "test" },
      signals: [],
      agents: [
        {
          id: "custom",
          name: "Custom Agent",
          description: "Do something custom",
          needs: ["unknown-capability"],
        },
      ],
      jobs: [],
    };

    const classified = classifyAgents(plan);

    assertEquals(classified.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    const first = classified[0]!;
    assertEquals(first.type.kind, "llm");
  });
});
