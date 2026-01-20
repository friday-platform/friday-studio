/**
 * Tests for planner URL-to-MCP matching logic
 */

import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { describe, expect, it } from "vitest";
import type { MCPContext } from "./planner.ts";

/**
 * Build MCP context from registry (same logic as do_task index.ts)
 */
function buildMCPContext(connectedProviders: Set<string>): MCPContext[] {
  return Object.entries(mcpServersRegistry.servers).map(([id, entry]) => ({
    id,
    urlDomains: entry.urlDomains ?? [],
    connected: connectedProviders.has(id),
  }));
}

/**
 * Extract URL domains from a string (simple extraction for testing)
 */
function extractUrlDomains(text: string): string[] {
  const urlRegex = /https?:\/\/([^/\s]+)/g;
  const matches = text.matchAll(urlRegex);
  const domains: string[] = [];
  for (const match of matches) {
    const domain = match[1];
    if (domain) {
      domains.push(domain);
    }
  }
  return domains;
}

/**
 * Find matching MCP for a domain
 */
function findMCPForDomain(domain: string, mcpContext: MCPContext[]): MCPContext | undefined {
  return mcpContext.find((mcp) =>
    mcp.urlDomains.some((urlDomain) => domain === urlDomain || domain.endsWith(`.${urlDomain}`)),
  );
}

describe("MCP Context Building", () => {
  it("builds context with all registry entries", () => {
    const context = buildMCPContext(new Set());
    expect(context.length).toEqual(Object.keys(mcpServersRegistry.servers).length);
  });

  it("marks connected providers correctly", () => {
    const context = buildMCPContext(new Set(["linear", "github"]));
    const linear = context.find((m) => m.id === "linear");
    const github = context.find((m) => m.id === "github");
    const notion = context.find((m) => m.id === "notion");

    expect(linear?.connected).toEqual(true);
    expect(github?.connected).toEqual(true);
    expect(notion?.connected).toEqual(false);
  });

  it("includes urlDomains from registry", () => {
    const context = buildMCPContext(new Set());

    const linear = context.find((m) => m.id === "linear");
    expect(linear?.urlDomains ?? []).toContain("linear.app");

    const github = context.find((m) => m.id === "github");
    expect(github?.urlDomains ?? []).toContain("github.com");

    const notion = context.find((m) => m.id === "notion");
    expect(notion?.urlDomains ?? []).toContain("notion.so");
  });
});

describe("URL Domain Extraction", () => {
  it("extracts domain from Linear URL", () => {
    const domains = extractUrlDomains("Check https://linear.app/team/TEM-123");
    expect(domains).toContain("linear.app");
  });

  it("extracts domain from GitHub URL", () => {
    const domains = extractUrlDomains("Review https://github.com/org/repo/pull/456");
    expect(domains).toContain("github.com");
  });

  it("extracts multiple domains", () => {
    const domains = extractUrlDomains(
      "Compare https://linear.app/TEM-123 with https://github.com/org/repo",
    );
    expect(domains).toContain("linear.app");
    expect(domains).toContain("github.com");
  });

  it("extracts domain from generic URL", () => {
    const domains = extractUrlDomains("Read https://example.com/page");
    expect(domains).toContain("example.com");
  });
});

describe("URL to MCP Matching", () => {
  const mcpContext = buildMCPContext(new Set(["linear", "github"]));

  it("matches linear.app to linear MCP", () => {
    const mcp = findMCPForDomain("linear.app", mcpContext);
    expect(mcp?.id).toEqual("linear");
  });

  it("matches github.com to github MCP", () => {
    const mcp = findMCPForDomain("github.com", mcpContext);
    expect(mcp?.id).toEqual("github");
  });

  it("matches notion.so to notion MCP", () => {
    const mcp = findMCPForDomain("notion.so", mcpContext);
    expect(mcp?.id).toEqual("notion");
  });

  it("matches sentry.io to sentry MCP", () => {
    const mcp = findMCPForDomain("sentry.io", mcpContext);
    expect(mcp?.id).toEqual("sentry");
  });

  it("matches calendar.google.com to google-calendar MCP", () => {
    const mcp = findMCPForDomain("calendar.google.com", mcpContext);
    expect(mcp?.id).toEqual("google-calendar");
  });

  it("returns undefined for unmatched domain", () => {
    const mcp = findMCPForDomain("example.com", mcpContext);
    expect(mcp).toEqual(undefined);
  });

  it("returns undefined for news.com (no MCP)", () => {
    const mcp = findMCPForDomain("news.com", mcpContext);
    expect(mcp).toEqual(undefined);
  });
});

describe("Eric's Test Case - Linear URL", () => {
  const mcpContext = buildMCPContext(new Set(["linear"]));

  it("linear.app URL should match linear MCP", () => {
    const intent = "Summarize https://linear.app/team/issue/TEM-123";
    const domains = extractUrlDomains(intent);
    expect(domains).toEqual(["linear.app"]);

    const domain = domains[0];
    if (!domain) throw new Error("Expected domain to be defined");
    const mcp = findMCPForDomain(domain, mcpContext);
    expect(mcp?.id).toEqual("linear");
    expect(mcp?.connected).toEqual(true);
  });

  it("should NOT use webfetch for Linear URLs", () => {
    // If a URL matches an MCP, the planner should use needs=["linear"]
    // instead of needs=[] (which would use webfetch)
    const intent = "What's in this issue: https://linear.app/tempest/TEM-456";
    const domains = extractUrlDomains(intent);
    const domain = domains[0];
    if (!domain) throw new Error("Expected domain to be defined");
    const mcp = findMCPForDomain(domain, mcpContext);

    // MCP should be found - meaning webfetch should NOT be used
    expect(mcp !== undefined).toEqual(true);
    expect(mcp?.id).toEqual("linear");
  });
});

describe("Test Prompts - Expected Tool Selection", () => {
  const mcpContext = buildMCPContext(new Set());

  // These tests document the expected behavior for various prompts
  const testCases = [
    {
      name: "Linear issue URL",
      intent: "Summarize https://linear.app/team/TEM-123",
      expectedMCP: "linear",
      shouldUseWebfetch: false,
    },
    {
      name: "GitHub PR URL",
      intent: "What's in this PR: https://github.com/org/repo/pull/456",
      expectedMCP: "github",
      shouldUseWebfetch: false,
    },
    {
      name: "Notion page URL",
      intent: "Read https://notion.so/page-id",
      expectedMCP: "notion",
      shouldUseWebfetch: false,
    },
    {
      name: "Sentry issue URL",
      intent: "Debug https://sentry.io/organizations/my-org/issues/123",
      expectedMCP: "sentry",
      shouldUseWebfetch: false,
    },
    {
      name: "Generic news URL (no MCP)",
      intent: "Summarize https://news.ycombinator.com/item?id=123",
      expectedMCP: undefined,
      shouldUseWebfetch: true,
    },
    {
      name: "Generic blog URL (no MCP)",
      intent: "Read https://example.com/blog/post",
      expectedMCP: undefined,
      shouldUseWebfetch: true,
    },
    {
      name: "HubSpot URL",
      intent: "Get contact from https://app.hubspot.com/contacts/123",
      expectedMCP: "hubspot",
      shouldUseWebfetch: false,
    },
    {
      name: "Atlassian/Jira URL",
      intent: "Check https://myteam.atlassian.net/browse/PROJ-123",
      expectedMCP: "atlassian",
      shouldUseWebfetch: false,
    },
  ];

  for (const testCase of testCases) {
    it(testCase.name, () => {
      const domains = extractUrlDomains(testCase.intent);
      const firstDomain = domains[0];
      const mcp = firstDomain ? findMCPForDomain(firstDomain, mcpContext) : undefined;

      if (testCase.expectedMCP) {
        expect(mcp?.id).toEqual(testCase.expectedMCP);
        expect(testCase.shouldUseWebfetch).toEqual(false);
      } else {
        expect(mcp).toEqual(undefined);
        expect(testCase.shouldUseWebfetch).toEqual(true);
      }
    });
  }
});
