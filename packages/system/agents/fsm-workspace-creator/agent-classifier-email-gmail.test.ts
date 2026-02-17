/**
 * Unit tests for email vs Gmail agent classification layers.
 *
 * Tests the individual matching layers (keyword extraction, bundled matching,
 * MCP matching) that feed into classifyAgents(). End-to-end pipeline tests
 * (classifyAgents + generateMCPServers) live in
 * email-gmail-classification-pipeline.test.ts.
 *
 * Ref: Sentry ATLAS-29X — email agent selected for Gmail retrieval,
 * causing 734 recurring errors.
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import {
  extractKeywordsFromNeed,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import { describe, expect, it } from "vitest";
import { classifyAgents } from "./agent-classifier.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makePlan(agents: WorkspacePlan["agents"]): WorkspacePlan {
  return { workspace: { name: "test", purpose: "test" }, signals: [], agents, jobs: [] };
}

function classify(needs: string[]) {
  const plan = makePlan([{ id: "test-agent", name: "Test Agent", description: "test", needs }]);
  const classified = classifyAgents(plan);
  const agent = classified[0];
  if (!agent) throw new Error("Expected exactly one classified agent");
  return agent;
}

// ---------------------------------------------------------------------------
// 1. Keyword extraction — only extracts bundled agent capabilities
// ---------------------------------------------------------------------------

describe("extractKeywordsFromNeed — email/gmail disambiguation", () => {
  it("'email' extracts email keyword (bundled capability)", () => {
    const keywords = extractKeywordsFromNeed("email");
    expect(keywords).toContain("email");
  });

  it("'gmail' returns as-is (not a bundled capability)", () => {
    const keywords = extractKeywordsFromNeed("gmail");
    expect(keywords).toEqual(["gmail"]);
  });

  it("'google-gmail' returns as-is (no bundled capability match)", () => {
    // Only bundled agent capabilities are checked — MCP domains like "gmail"
    // are matched separately by mapNeedToMCPServers
    const keywords = extractKeywordsFromNeed("google-gmail");
    expect(keywords).toEqual(["google-gmail"]);
  });

  it("'html-email' extracts email keyword via substring", () => {
    const keywords = extractKeywordsFromNeed("html-email");
    expect(keywords).toContain("email");
  });

  it("'email-notifications' extracts both email and notifications", () => {
    const keywords = extractKeywordsFromNeed("email-notifications");
    expect(keywords).toContain("email");
    expect(keywords).toContain("notifications");
  });

  it("'sendgrid' extracts sendgrid keyword", () => {
    const keywords = extractKeywordsFromNeed("sendgrid");
    expect(keywords).toContain("sendgrid");
  });
});

// ---------------------------------------------------------------------------
// 2. Bundled agent matching
// ---------------------------------------------------------------------------

describe("matchBundledAgents — email/gmail disambiguation", () => {
  it("'email' matches only the email bundled agent", () => {
    const matches = matchBundledAgents(["email"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.agentId).toBe("email");
  });

  it("'gmail' does not match any bundled agent", () => {
    const matches = matchBundledAgents(["gmail"]);
    expect(matches).toHaveLength(0);
  });

  it("'google-gmail' does not match any bundled agent", () => {
    const matches = matchBundledAgents(["google-gmail"]);
    expect(matches).toHaveLength(0);
  });

  it("'inbox' does not match any bundled agent", () => {
    const matches = matchBundledAgents(["inbox"]);
    expect(matches).toHaveLength(0);
  });

  it("'sendgrid' matches the email bundled agent", () => {
    const matches = matchBundledAgents(["sendgrid"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.agentId).toBe("email");
  });

  it("'notifications' matches BOTH email and slack (ambiguous)", () => {
    const matches = matchBundledAgents(["notifications"]);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.find((m) => m.agentId === "email")).toBeDefined();
    expect(matches.find((m) => m.agentId === "slack")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. MCP server matching
// ---------------------------------------------------------------------------

describe("mapNeedToMCPServers — email/gmail", () => {
  it("'gmail' matches google-gmail MCP server", async () => {
    const matches = await mapNeedToMCPServers("gmail");
    expect(matches.find((m) => m.serverId === "google-gmail")).toBeDefined();
  });

  it("'google-gmail' matches google-gmail MCP server", async () => {
    const matches = await mapNeedToMCPServers("google-gmail");
    expect(matches.find((m) => m.serverId === "google-gmail")).toBeDefined();
  });

  it("'inbox' matches google-gmail MCP server", async () => {
    const matches = await mapNeedToMCPServers("inbox");
    expect(matches.find((m) => m.serverId === "google-gmail")).toBeDefined();
  });

  it("'email' matches google-gmail MCP server", async () => {
    const matches = await mapNeedToMCPServers("email");
    expect(matches.find((m) => m.serverId === "google-gmail")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Classification — table-driven (detailed pipeline tests in pipeline file)
// ---------------------------------------------------------------------------

describe("classifyAgents — email/gmail routing", () => {
  it.each([
    { name: "email → bundled email", needs: ["email"], kind: "bundled", bundledId: "email" },
    {
      name: "html-email → bundled email",
      needs: ["html-email"],
      kind: "bundled",
      bundledId: "email",
    },
    { name: "sendgrid → bundled email", needs: ["sendgrid"], kind: "bundled", bundledId: "email" },
    {
      name: "email + sendgrid → bundled email (all covered)",
      needs: ["email", "sendgrid"],
      kind: "bundled",
      bundledId: "email",
    },
    {
      name: "email + gmail → LLM (bundled email only covers email, not gmail)",
      needs: ["email", "gmail"],
      kind: "llm",
    },
    { name: "gmail → LLM", needs: ["gmail"], kind: "llm" },
    { name: "google-gmail → LLM", needs: ["google-gmail"], kind: "llm" },
    { name: "inbox → LLM", needs: ["inbox"], kind: "llm" },
    { name: "gmail + google-gmail → LLM", needs: ["gmail", "google-gmail"], kind: "llm" },
    { name: "notifications → LLM (ambiguous)", needs: ["notifications"], kind: "llm" },
    { name: "messaging → LLM (ambiguous)", needs: ["messaging"], kind: "llm" },
    { name: "email + slack → LLM (ambiguous)", needs: ["email", "slack"], kind: "llm" },
    {
      name: "calendar → bundled google-calendar",
      needs: ["calendar"],
      kind: "bundled",
      bundledId: "google-calendar",
    },
    {
      name: "google-calendar → bundled google-calendar",
      needs: ["google-calendar"],
      kind: "bundled",
      bundledId: "google-calendar",
    },
    { name: "google-sheets → LLM (TEM-3652)", needs: ["google-sheets"], kind: "llm" },
  ])("$name", ({ needs, kind, bundledId }) => {
    const agent = classify(needs);
    expect(agent.type.kind).toBe(kind);
    if (bundledId) {
      expect(agent.type).toMatchObject({ bundledId });
    } else {
      expect(agent.type).not.toHaveProperty("bundledId");
    }
  });
});
