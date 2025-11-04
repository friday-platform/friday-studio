import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  type BundledAgentMatch,
  findUnmatchedNeeds,
  type MCPServerMatch,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "./deterministic-matching.ts";

describe("matchBundledAgents", () => {
  it("matches slack capability case-insensitively", () => {
    const matches = matchBundledAgents(["slack"]);

    assertEquals(matches.length >= 1, true, "Should find at least one slack match");
    const slackMatch = matches.find((m) => m.agentId === "slack");
    assertEquals(slackMatch !== undefined, true, "Should find slack agent");
    assertEquals(
      slackMatch !== undefined && slackMatch.matchedCapabilities.length > 0,
      true,
      "Should have matched capabilities",
    );
  });

  it("matches email capability", () => {
    const matches = matchBundledAgents(["email"]);

    assertEquals(matches.length >= 1, true, "Should find at least one email match");
    const emailMatch = matches.find((m) => m.agentId === "email");
    assertEquals(emailMatch !== undefined, true, "Should find email agent");
  });

  it("returns multiple matches for generic need", () => {
    const matches = matchBundledAgents(["notifications"]);

    // Both slack and email have "notifications" capability
    assertEquals(matches.length >= 2, true, "Should find multiple matches for notifications");
  });

  it("returns empty array for no matches", () => {
    const matches = matchBundledAgents(["nonexistent-capability"]);

    assertEquals(matches.length, 0);
  });

  it("matches case-insensitively", () => {
    const matches = matchBundledAgents(["SLACK"]);

    assertEquals(matches.length >= 1, true, "Should match regardless of case");
  });

  it("returns empty for empty needs", () => {
    const matches = matchBundledAgents([]);

    assertEquals(matches.length, 0);
  });

  it("handles whitespace-only needs", () => {
    const matches = matchBundledAgents(["  ", "\t", "\n"]);

    assertEquals(matches.length, 0);
  });

  it("trims whitespace from needs", () => {
    const matches = matchBundledAgents(["  slack  "]);

    assertEquals(matches.length >= 1, true, "Should match after trimming");
  });
});

describe("mapNeedToMCPServers", () => {
  it("matches github to github MCP server", () => {
    const matches = mapNeedToMCPServers("github");

    assertEquals(matches.length >= 1, true, "Should find github MCP server");
    const githubMatch = matches.find((m) => m.serverId.includes("github"));
    assertEquals(githubMatch !== undefined, true, "Should find github-related server");
  });

  it("returns empty for empty need", () => {
    const matches = mapNeedToMCPServers("");

    assertEquals(matches.length, 0);
  });

  it("matches case-insensitively", () => {
    const matchesLower = mapNeedToMCPServers("github");
    const matchesUpper = mapNeedToMCPServers("GITHUB");

    assertEquals(matchesLower.length, matchesUpper.length, "Case should not matter");
  });

  it("returns empty for nonexistent need", () => {
    const matches = mapNeedToMCPServers("completely-fake-service-xyz");

    assertEquals(matches.length, 0);
  });
});

describe("findUnmatchedNeeds", () => {
  it("returns empty if bundled agent matches", () => {
    const needs = ["slack", "messaging"];
    const bundledMatches = matchBundledAgents(needs);
    const mcpMatches = new Map<string, MCPServerMatch[]>();

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    assertEquals(unmatched.length, 0, "Bundled match satisfies all needs");
  });

  it("returns needs with no MCP matches", () => {
    const needs = ["github", "fake-service"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map([
      ["github", mapNeedToMCPServers("github")],
      ["fake-service", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    assertEquals(unmatched, ["fake-service"]);
  });

  it("returns all needs if no matches at all", () => {
    const needs = ["fake1", "fake2"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map([
      ["fake1", []],
      ["fake2", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    assertEquals(unmatched, ["fake1", "fake2"]);
  });
});
