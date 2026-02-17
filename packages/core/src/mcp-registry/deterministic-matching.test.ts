import { describe, expect, it } from "vitest";
import {
  type BundledAgentMatch,
  extractKeywordsFromNeed,
  findFullBundledMatch,
  findUnmatchedNeeds,
  type MCPServerMatch,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "./deterministic-matching.ts";

describe("extractKeywordsFromNeed", () => {
  it("returns exact capability match", () => {
    const keywords = extractKeywordsFromNeed("slack");
    expect(keywords).toContain("slack");
  });

  it("does not match partial segments — 'data-analysis' should not extract 'data'", () => {
    const keywords = extractKeywordsFromNeed("data-analysis");
    expect(keywords).toContain("data-analysis");
    expect(keywords).not.toContain("data");
  });

  it("matches suffix segments — 'html-email' extracts 'email'", () => {
    const keywords = extractKeywordsFromNeed("html-email");
    expect(keywords).toContain("email");
  });

  it("returns normalized need when no keywords match", () => {
    const keywords = extractKeywordsFromNeed("totally-unknown-thing");
    expect(keywords).toEqual(["totally-unknown-thing"]);
  });
});

describe("matchBundledAgents", () => {
  it("matches slack capability case-insensitively", () => {
    const matches = matchBundledAgents(["slack"]);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const slackMatch = matches.find((m) => m.agentId === "slack");
    expect(slackMatch).toBeDefined();
    expect(slackMatch?.matchedCapabilities.length).toBeGreaterThan(0);
  });

  it("matches email capability", () => {
    const matches = matchBundledAgents(["email"]);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const emailMatch = matches.find((m) => m.agentId === "email");
    expect(emailMatch).toBeDefined();
  });

  it("returns multiple matches for generic need", () => {
    const matches = matchBundledAgents(["notifications"]);

    // Both slack and email have "notifications" capability
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for no matches", () => {
    const matches = matchBundledAgents(["nonexistent-capability"]);

    expect(matches).toHaveLength(0);
  });

  it("matches case-insensitively", () => {
    const matches = matchBundledAgents(["SLACK"]);

    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for empty needs", () => {
    const matches = matchBundledAgents([]);

    expect(matches).toHaveLength(0);
  });

  it("handles whitespace-only needs", () => {
    const matches = matchBundledAgents(["  ", "\t", "\n"]);

    expect(matches).toHaveLength(0);
  });

  it("trims whitespace from needs", () => {
    const matches = matchBundledAgents(["  slack  "]);

    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("gmail does not resolve to email agent", () => {
    const matches = matchBundledAgents(["gmail"]);

    expect(matches).toHaveLength(0);
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

  it("data-analysis resolves to data-analyst only, not table agent", () => {
    // Regression: extractKeywordsFromNeed("data-analysis") was extracting "data"
    // via substring match, which matched the table agent's "data" capability
    const keywords = extractKeywordsFromNeed("data-analysis");
    const matches = matchBundledAgents(keywords);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.agentId).toEqual("data-analyst");
  });
});

describe("mapNeedToMCPServers", () => {
  it("matches github to github MCP server", async () => {
    const matches = await mapNeedToMCPServers("github");

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const githubMatch = matches.find((m) => m.serverId.includes("github"));
    expect(githubMatch).toBeDefined();
  });

  it("returns empty for empty need", async () => {
    const matches = await mapNeedToMCPServers("");

    expect(matches).toHaveLength(0);
  });

  it("matches case-insensitively", async () => {
    const matchesLower = await mapNeedToMCPServers("github");
    const matchesUpper = await mapNeedToMCPServers("GITHUB");

    expect(matchesLower).toHaveLength(matchesUpper.length);
  });

  it("returns empty for nonexistent need", async () => {
    const matches = await mapNeedToMCPServers("completely-fake-service-xyz");

    expect(matches).toHaveLength(0);
  });
});

describe("findFullBundledMatch", () => {
  it("returns match when single bundled agent covers all needs", () => {
    const match = findFullBundledMatch(["email", "sendgrid"]);

    expect(match).not.toBeNull();
    expect(match?.agentId).toBe("email");
  });

  it("returns null when bundled agent only partially covers needs", () => {
    // "email" matches bundled email, but "gmail" does not — partial coverage
    const match = findFullBundledMatch(["email", "gmail"]);

    expect(match).toBeNull();
  });

  it("returns null when multiple bundled agents match (ambiguous)", () => {
    // "notifications" matches both email and slack
    const match = findFullBundledMatch(["notifications"]);

    expect(match).toBeNull();
  });

  it("returns null when no bundled agent matches", () => {
    const match = findFullBundledMatch(["gmail"]);

    expect(match).toBeNull();
  });
});

describe("findUnmatchedNeeds", () => {
  it("returns empty if bundled agent matches", () => {
    const needs = ["slack", "messaging"];
    const bundledMatches = matchBundledAgents(needs);
    const mcpMatches = new Map<string, MCPServerMatch[]>();

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched).toHaveLength(0);
  });

  it("returns needs with no MCP matches", async () => {
    const needs = ["github", "fake-service"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map<string, MCPServerMatch[]>([
      ["github", await mapNeedToMCPServers("github")],
      ["fake-service", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched).toEqual(["fake-service"]);
  });

  it("returns all needs if no matches at all", () => {
    const needs = ["fake1", "fake2"];
    const bundledMatches: BundledAgentMatch[] = [];
    const mcpMatches = new Map<string, MCPServerMatch[]>([
      ["fake1", []],
      ["fake2", []],
    ]);

    const unmatched = findUnmatchedNeeds(needs, bundledMatches, mcpMatches);

    expect(unmatched).toEqual(["fake1", "fake2"]);
  });
});
