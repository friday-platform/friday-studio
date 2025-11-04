import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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

    assertEquals(formatted.includes("Slack Notifier"), true);
    assertEquals(formatted.includes("Slack Agent"), true);
    assertEquals(formatted.includes("channel"), true);
    assertEquals(formatted.includes("No channel specified"), true);
  });

  it("formats MCP missing fields clarification", () => {
    const clarification = createMCPMissingFieldsClarification(
      "GitHub Monitor",
      ["github"],
      { serverId: "github", name: "GitHub", matchedDomains: ["github"], requiredConfig: [] },
      [{ field: "GITHUB_TOKEN", reason: "Token not provided" }],
    );

    const formatted = formatClarificationReport([clarification]);

    assertEquals(formatted.includes("GitHub"), true);
    assertEquals(formatted.includes("GITHUB_TOKEN"), true);
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

    assertEquals(formatted.includes("Multiple bundled agents match"), true);
    assertEquals(formatted.includes("Slack"), true);
    assertEquals(formatted.includes("Email"), true);
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

    assertEquals(formatted.includes('Multiple MCP servers match "monitoring"'), true);
    assertEquals(formatted.includes("Prometheus"), true);
    assertEquals(formatted.includes("Datadog"), true);
  });

  it("formats no-match clarification", () => {
    const clarification = createNoMatchClarification("Agent", "fake-service");

    const formatted = formatClarificationReport([clarification]);

    assertEquals(formatted.includes("No integration found"), true);
    assertEquals(formatted.includes("fake-service"), true);
    assertEquals(formatted.includes("Be more specific"), true);
  });

  it("groups multiple clarifications by agent", () => {
    const clarifications = [
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent A", "service2"),
      createNoMatchClarification("Agent B", "service3"),
    ];

    const formatted = formatClarificationReport(clarifications);

    // Should have two agent sections
    assertEquals(formatted.includes("**Agent A**"), true);
    assertEquals(formatted.includes("**Agent B**"), true);

    // Should have summary
    assertEquals(formatted.includes("3 issues"), true);
    assertEquals(formatted.includes("2 agents"), true);
  });

  it("returns empty string for empty clarifications", () => {
    const formatted = formatClarificationReport([]);

    assertEquals(formatted, "");
  });

  it("handles singular vs plural in summary", () => {
    const single = formatClarificationReport([createNoMatchClarification("Agent", "service")]);

    assertEquals(single.includes("1 issue"), true);
    assertEquals(single.includes("1 agent"), true);

    const multiple = formatClarificationReport([
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent B", "service2"),
    ]);

    assertEquals(multiple.includes("2 issues"), true);
    assertEquals(multiple.includes("2 agents"), true);
  });
});
