import { describe, expect, it } from "vitest";
import {
  type AmbiguousBundledClarification,
  type AmbiguousMCPClarification,
  type BundledClarification,
  createNoMatchClarification,
  formatClarificationReport,
  type MCPClarification,
} from "./clarification.ts";

describe("formatClarificationReport", () => {
  it("formats bundled missing fields clarification", () => {
    const clarification: BundledClarification = {
      type: "bundled-missing-fields",
      agentName: "Slack Notifier",
      needs: ["slack"],
      matchedAgent: { id: "slack", name: "Slack Agent", description: "Posts to Slack" },
      missingFields: [{ field: "channel", reason: "No channel specified" }],
    };

    const formatted = formatClarificationReport([clarification]);

    expect(formatted).toContain("Slack Notifier");
    expect(formatted).toContain("Slack Agent");
    expect(formatted).toContain("channel");
    expect(formatted).toContain("No channel specified");
  });

  it("formats MCP missing fields clarification", () => {
    const clarification: MCPClarification = {
      type: "mcp-missing-fields",
      agentName: "GitHub Monitor",
      needs: ["github"],
      matchedServer: { id: "github", name: "GitHub" },
      missingFields: [{ field: "GITHUB_TOKEN", reason: "Token not provided" }],
    };

    const formatted = formatClarificationReport([clarification]);

    expect(formatted).toContain("GitHub");
    expect(formatted).toContain("GITHUB_TOKEN");
  });

  it("formats ambiguous bundled clarification", () => {
    const clarification: AmbiguousBundledClarification = {
      type: "bundled-ambiguous",
      agentName: "Notifier",
      needs: ["notifications"],
      matches: [
        {
          id: "slack",
          name: "Slack",
          description: "Slack messaging",
          matchedCapabilities: ["notifications"],
        },
        {
          id: "email",
          name: "Email",
          description: "Email sending",
          matchedCapabilities: ["notifications"],
        },
      ],
    };

    const formatted = formatClarificationReport([clarification]);

    expect(formatted).toContain("Multiple bundled agents match");
    expect(formatted).toContain("Slack");
    expect(formatted).toContain("Email");
  });

  it("formats ambiguous MCP clarification", () => {
    const clarification: AmbiguousMCPClarification = {
      type: "mcp-ambiguous",
      agentName: "Monitor",
      need: "monitoring",
      matches: [
        { id: "prometheus", name: "Prometheus", matchedDomains: ["monitoring"] },
        { id: "datadog", name: "Datadog", matchedDomains: ["monitoring"] },
      ],
    };

    const formatted = formatClarificationReport([clarification]);

    expect(formatted).toContain('Multiple MCP servers match "monitoring"');
    expect(formatted).toContain("Prometheus");
    expect(formatted).toContain("Datadog");
  });

  it("formats no-match clarification", () => {
    const clarification = createNoMatchClarification("Agent", "fake-service");

    const formatted = formatClarificationReport([clarification]);

    expect(formatted).toContain("No integration found");
    expect(formatted).toContain("fake-service");
    expect(formatted).toContain("Be more specific");
  });

  it("groups multiple clarifications by agent", () => {
    const clarifications = [
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent A", "service2"),
      createNoMatchClarification("Agent B", "service3"),
    ];

    const formatted = formatClarificationReport(clarifications);

    // Should have two agent sections
    expect(formatted).toContain("**Agent A**");
    expect(formatted).toContain("**Agent B**");

    // Should have summary
    expect(formatted).toContain("3 issues");
    expect(formatted).toContain("2 agents");
  });

  it("returns empty string for empty clarifications", () => {
    const formatted = formatClarificationReport([]);

    expect(formatted).toEqual("");
  });

  it("handles singular vs plural in summary", () => {
    const single = formatClarificationReport([createNoMatchClarification("Agent", "service")]);

    expect(single).toContain("1 issue");
    expect(single).toContain("1 agent");

    const multiple = formatClarificationReport([
      createNoMatchClarification("Agent A", "service1"),
      createNoMatchClarification("Agent B", "service2"),
    ]);

    expect(multiple).toContain("2 issues");
    expect(multiple).toContain("2 agents");
  });
});
