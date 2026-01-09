/**
 * Tests for planner URL-to-MCP matching logic
 */

import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { assertArrayIncludes, assertEquals } from "@std/assert";
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

Deno.test("MCP Context Building", async (t) => {
  await t.step("builds context with all registry entries", () => {
    const context = buildMCPContext(new Set());
    assertEquals(context.length, Object.keys(mcpServersRegistry.servers).length);
  });

  await t.step("marks connected providers correctly", () => {
    const context = buildMCPContext(new Set(["linear", "github"]));
    const linear = context.find((m) => m.id === "linear");
    const github = context.find((m) => m.id === "github");
    const notion = context.find((m) => m.id === "notion");

    assertEquals(linear?.connected, true);
    assertEquals(github?.connected, true);
    assertEquals(notion?.connected, false);
  });

  await t.step("includes urlDomains from registry", () => {
    const context = buildMCPContext(new Set());

    const linear = context.find((m) => m.id === "linear");
    assertArrayIncludes(linear?.urlDomains ?? [], ["linear.app"]);

    const github = context.find((m) => m.id === "github");
    assertArrayIncludes(github?.urlDomains ?? [], ["github.com"]);

    const notion = context.find((m) => m.id === "notion");
    assertArrayIncludes(notion?.urlDomains ?? [], ["notion.so"]);
  });
});

Deno.test("URL Domain Extraction", async (t) => {
  await t.step("extracts domain from Linear URL", () => {
    const domains = extractUrlDomains("Check https://linear.app/team/TEM-123");
    assertArrayIncludes(domains, ["linear.app"]);
  });

  await t.step("extracts domain from GitHub URL", () => {
    const domains = extractUrlDomains("Review https://github.com/org/repo/pull/456");
    assertArrayIncludes(domains, ["github.com"]);
  });

  await t.step("extracts multiple domains", () => {
    const domains = extractUrlDomains(
      "Compare https://linear.app/TEM-123 with https://github.com/org/repo",
    );
    assertArrayIncludes(domains, ["linear.app", "github.com"]);
  });

  await t.step("extracts domain from generic URL", () => {
    const domains = extractUrlDomains("Read https://example.com/page");
    assertArrayIncludes(domains, ["example.com"]);
  });
});

Deno.test("URL to MCP Matching", async (t) => {
  const mcpContext = buildMCPContext(new Set(["linear", "github"]));

  await t.step("matches linear.app to linear MCP", () => {
    const mcp = findMCPForDomain("linear.app", mcpContext);
    assertEquals(mcp?.id, "linear");
  });

  await t.step("matches github.com to github MCP", () => {
    const mcp = findMCPForDomain("github.com", mcpContext);
    assertEquals(mcp?.id, "github");
  });

  await t.step("matches notion.so to notion MCP", () => {
    const mcp = findMCPForDomain("notion.so", mcpContext);
    assertEquals(mcp?.id, "notion");
  });

  await t.step("matches sentry.io to sentry MCP", () => {
    const mcp = findMCPForDomain("sentry.io", mcpContext);
    assertEquals(mcp?.id, "sentry");
  });

  await t.step("matches calendar.google.com to google-calendar MCP", () => {
    const mcp = findMCPForDomain("calendar.google.com", mcpContext);
    assertEquals(mcp?.id, "google-calendar");
  });

  await t.step("returns undefined for unmatched domain", () => {
    const mcp = findMCPForDomain("example.com", mcpContext);
    assertEquals(mcp, undefined);
  });

  await t.step("returns undefined for news.com (no MCP)", () => {
    const mcp = findMCPForDomain("news.com", mcpContext);
    assertEquals(mcp, undefined);
  });
});

Deno.test("Eric's Test Case - Linear URL", async (t) => {
  const mcpContext = buildMCPContext(new Set(["linear"]));

  await t.step("linear.app URL should match linear MCP", () => {
    const intent = "Summarize https://linear.app/team/issue/TEM-123";
    const domains = extractUrlDomains(intent);
    assertEquals(domains, ["linear.app"]);

    const domain = domains[0];
    if (!domain) throw new Error("Expected domain to be defined");
    const mcp = findMCPForDomain(domain, mcpContext);
    assertEquals(mcp?.id, "linear");
    assertEquals(mcp?.connected, true);
  });

  await t.step("should NOT use webfetch for Linear URLs", () => {
    // If a URL matches an MCP, the planner should use needs=["linear"]
    // instead of needs=[] (which would use webfetch)
    const intent = "What's in this issue: https://linear.app/tempest/TEM-456";
    const domains = extractUrlDomains(intent);
    const domain = domains[0];
    if (!domain) throw new Error("Expected domain to be defined");
    const mcp = findMCPForDomain(domain, mcpContext);

    // MCP should be found - meaning webfetch should NOT be used
    assertEquals(mcp !== undefined, true);
    assertEquals(mcp?.id, "linear");
  });
});

Deno.test("Test Prompts - Expected Tool Selection", async (t) => {
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
    await t.step(testCase.name, () => {
      const domains = extractUrlDomains(testCase.intent);
      const firstDomain = domains[0];
      const mcp = firstDomain ? findMCPForDomain(firstDomain, mcpContext) : undefined;

      if (testCase.expectedMCP) {
        assertEquals(mcp?.id, testCase.expectedMCP, `Expected MCP: ${testCase.expectedMCP}`);
        assertEquals(testCase.shouldUseWebfetch, false);
      } else {
        assertEquals(mcp, undefined, "Should not match any MCP");
        assertEquals(testCase.shouldUseWebfetch, true);
      }
    });
  }
});
