import type { WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
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

    expect(classified.length).toEqual(1);
    expect(classified[0]?.type.kind).toEqual("bundled");
    if (classified[0]?.type.kind === "bundled") {
      expect(classified[0]?.type.bundledId).toEqual("email");
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

    expect(classified.length).toEqual(1);
    expect(classified[0]?.type.kind, "html-email should match email agent").toEqual("bundled");
    if (classified[0]?.type.kind === "bundled") {
      expect(classified[0]?.type.bundledId).toEqual("email");
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

    expect(classified.length).toEqual(1);
    expect(classified[0]?.type.kind, "email-formatting should match email agent").toEqual(
      "bundled",
    );
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

    expect(classified.length).toEqual(1);
    expect(classified[0]?.type.kind).toEqual("llm");
  });

  it("classifies google-sheets agent as llm, not bundled google-calendar (TEM-3652)", () => {
    // Regression test: google-sheets should use MCP server, not google-calendar bundled agent
    const plan: WorkspacePlan = {
      workspace: { name: "test", purpose: "test" },
      signals: [],
      agents: [
        {
          id: "sheets-agent",
          name: "Sheets Agent",
          description: "Read and write spreadsheets",
          needs: ["google-sheets"],
        },
      ],
      jobs: [],
    };

    const classified = classifyAgents(plan);

    expect(classified.length).toEqual(1);
    expect(classified[0]?.type.kind).toEqual("llm");
    if (classified[0]?.type.kind === "llm") {
      expect(classified[0]?.type.mcpTools).toContain("google-sheets");
    }
  });
});
