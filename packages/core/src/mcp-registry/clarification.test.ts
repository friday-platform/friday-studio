import { describe, expect, it } from "vitest";
import {
  createAmbiguousBundledClarification,
  createAmbiguousMCPClarification,
  createBundledMissingFieldsClarification,
  createMCPMissingFieldsClarification,
  createNoMatchClarification,
  formatClarificationReport,
} from "./clarification.ts";

describe("formatClarificationReport", () => {
  it("formats bundled missing fields clarification", () => {
    const clarification = createBundledMissingFieldsClarification(
      "Slack Notifier",
      ["slack"],
      {
        agentId: "slack",
        name: "Slack Agent",
        description: "Posts to Slack",
        matchedCapabilities: ["slack"],
        requiredConfig: [],
      },
      [{ field: "channel", reason: "No channel specified" }],
    );

    const formatted = formatClarificationReport([clarification]);

    expect(formatted.includes("Slack Notifier")).toBe(true);
    expect(formatted.includes("Slack Agent")).toBe(true);
    expect(formatted.includes("channel")).toBe(true);
    expect(formatted.includes("No channel specified")).toBe(true);
  });

  it("formats MCP missing fields clarification", () => {
    const clarification = createMCPMissingFieldsClarification(
      "GitHub Monitor",
      ["github"],
      { serverId: "github", name: "GitHub", matchedDomains: ["github"], requiredConfig: [] },
      [{ field: "GITHUB_TOKEN", reason: "Token not provided" }],
    );

    const formatted = formatClarificationReport([clarification]);

    expect(formatted.includes("GitHub")).toBe(true);
    expect(formatted.includes("GITHUB_TOKEN")).toBe(true);
  });

  it("formats ambiguous bundled clarification", () => {
    const clarification = createAmbiguousBundledClarification(
      "Notifier",
      ["notifications"],
      [
        {
          agentId: "slack",
          name: "Slack",
          description: "Slack messaging",
          matchedCapabilities: ["notifications"],
          requiredConfig: [],
        },
        {
          agentId: "email",
          name: "Email",
          description: "Email sending",
          matchedCapabilities: ["notifications"],
          requiredConfig: [],
        },
      ],
    );

    const formatted = formatClarificationReport([clarification]);

    expect(formatted.includes("Multiple bundled agents match")).toBe(true);
    expect(formatted.includes("Slack")).toBe(true);
    expect(formatted.includes("Email")).toBe(true);
  });

  it("formats ambiguous MCP clarification", () => {
    const clarification = createAmbiguousMCPClarification("Monitor", "monitoring", [
      {
        serverId: "prometheus",
        name: "Prometheus",
        matchedDomains: ["monitoring"],
        requiredConfig: [],
      },
      { serverId: "datadog", name: "Datadog", matchedDomains: ["monitoring"], requiredConfig: [] },
    ]);

    const formatted = formatClarificationReport([clarification]);

    expect(formatted.includes('Multiple MCP servers match "monitoring"')).toBe(true);
    expect(formatted.includes("Prometheus")).toBe(true);
    expect(formatted.includes("Datadog")).toBe(true);
  });

  it("formats no-match clarification", () => {
    const clarification = createNoMatchClarification("Agent", "fake-service");

    const formatted = formatClarificationReport([clarification]);

    expect(formatted.includes("No integration found")).toBe(true);
    expect(formatted.includes("fake-service")).toBe(true);
    expect(formatted.includes("Be more specific")).toBe(true);
  });

  it("groups multiple clarifications by agent", () => {
    const clarifications = [
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent A", "service2"),
      createNoMatchClarification("Agent B", "service3"),
    ];

    const formatted = formatClarificationReport(clarifications);

    // Should have two agent sections
    expect(formatted.includes("**Agent A**")).toBe(true);
    expect(formatted.includes("**Agent B**")).toBe(true);

    // Should have summary
    expect(formatted.includes("3 issues")).toBe(true);
    expect(formatted.includes("2 agents")).toBe(true);
  });

  it("returns empty string for empty clarifications", () => {
    const formatted = formatClarificationReport([]);

    expect(formatted).toEqual("");
  });

  it("handles singular vs plural in summary", () => {
    const single = formatClarificationReport([createNoMatchClarification("Agent", "service")]);

    expect(single.includes("1 issue")).toBe(true);
    expect(single.includes("1 agent")).toBe(true);

    const multiple = formatClarificationReport([
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent B", "service2"),
    ]);

    expect(multiple.includes("2 issues")).toBe(true);
    expect(multiple.includes("2 agents")).toBe(true);
  });
});
