import { describe, expect, it } from "vitest";
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

    expect(matches.length >= 1).toEqual(true);
    const slackMatch = matches.find((m) => m.agentId === "slack");
    expect(slackMatch !== undefined).toEqual(true);
    expect(slackMatch !== undefined && slackMatch.matchedCapabilities.length > 0).toEqual(true);
  });

  it("matches email capability", () => {
    const matches = matchBundledAgents(["email"]);

    expect(matches.length >= 1).toEqual(true);
    const emailMatch = matches.find((m) => m.agentId === "email");
    expect(emailMatch !== undefined).toEqual(true);
  });

  it("returns multiple matches for generic need", () => {
    const matches = matchBundledAgents(["notifications"]);

    // Both slack and email have "notifications" capability
    expect(matches.length >= 2).toEqual(true);
  });

  it("returns empty array for no matches", () => {
    const matches = matchBundledAgents(["nonexistent-capability"]);

    expect(matches.length).toEqual(0);
  });

  it("matches case-insensitively", () => {
    const matches = matchBundledAgents(["SLACK"]);

    expect(matches.length >= 1).toEqual(true);
  });

  it("returns empty for empty needs", () => {
    const matches = matchBundledAgents([]);

    expect(matches.length).toEqual(0);
  });

  it("handles whitespace-only needs", () => {
    const matches = matchBundledAgents(["  ", "\t", "\n"]);

    expect(matches.length).toEqual(0);
  });

  it("trims whitespace from needs", () => {
    const matches = matchBundledAgents(["  slack  "]);

    expect(matches.length >= 1).toEqual(true);
  });

  it("gmail resolves to email agent", () => {
    const matches = matchBundledAgents(["gmail"]);

    expect(matches.length).toEqual(1);
    const match = matches[0];
    expect(match !== undefined && match.agentId === "email").toEqual(true);
  });

  it("google-sheets does not match google-calendar agent", () => {
    // Regression test for TEM-3652: generic "google" capability was causing
    // Google Sheets/Docs/Drive to incorrectly route to Google Calendar agent
    const matches = matchBundledAgents(["google-sheets"]);

    const calendarMatch = matches.find((m) => m.agentId === "google-calendar");
    expect(calendarMatch).toBeUndefined();
  });

  it("sheets does not match google-calendar agent", () => {
    const matches = matchBundledAgents(["sheets"]);

    const calendarMatch = matches.find((m) => m.agentId === "google-calendar");
    expect(calendarMatch).toBeUndefined();
  });
});

describe("mapNeedToMCPServers", () => {
  it("matches github to github MCP server", () => {
    const matches = mapNeedToMCPServers("github");

    expect(matches.length >= 1).toEqual(true);
    const githubMatch = matches.find((m) => m.serverId.includes("github"));
    expect(githubMatch !== undefined).toEqual(true);
  });

  it("returns empty for empty need", () => {
    const matches = mapNeedToMCPServers("");

    expect(matches.length).toEqual(0);
  });

  it("matches case-insensitively", () => {
    const matchesLower = mapNeedToMCPServers("github");
    const matchesUpper = mapNeedToMCPServers("GITHUB");

    expect(matchesLower.length).toEqual(matchesUpper.length);
  });

  it("returns empty for nonexistent need", () => {
    const matches = mapNeedToMCPServers("completely-fake-service-xyz");

    expect(matches.length).toEqual(0);
  });
});

describe("findUnmatchedNeeds", () => {
  it("returns empty if bundled agent matches", () => {
    const needs = ["slack", "messaging"];
    const bundledMatches = matchBundledAgents(needs);
    const mcpMatches = new Map<string, MCPServerMatch[]>();

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched.length).toEqual(0);
  });

  it("returns needs with no MCP matches", () => {
    const needs = ["github", "fake-service"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map([
      ["github", mapNeedToMCPServers("github")],
      ["fake-service", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched).toEqual(["fake-service"]);
  });

  it("returns all needs if no matches at all", () => {
    const needs = ["fake1", "fake2"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map([
      ["fake1", []],
      ["fake2", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched).toEqual(["fake1", "fake2"]);
  });
});
