/**
 * Email vs Gmail Classification Pipeline Tests
 *
 * Tests the EXACT production classification pipeline:
 *   WorkspacePlan → classifyAgents() → generateMCPServers()
 *
 * Uses realistic WorkspacePlan fixtures that mimic LLM-generated plans,
 * then runs the same classifyAgents() and generateMCPServers() functions
 * that production uses.
 *
 * Background: Sentry ATLAS-29X — bundled email agent (compose-only, SendGrid)
 * is selected for Gmail retrieval tasks due to substring matching bug in
 * extractKeywordsFromNeed().
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { classifyAgents } from "./agent-classifier.ts";
import { generateMCPServers } from "./enrichers/mcp-servers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid plan shell — tests only care about agents */
function makePlan(agents: WorkspacePlan["agents"]): WorkspacePlan {
  return {
    workspace: { name: "test", purpose: "test" },
    signals: [
      {
        id: "trigger",
        name: "Trigger",
        title: "Trigger",
        signalType: "schedule",
        description: "test",
      },
    ],
    agents,
    jobs: [
      {
        id: "job",
        name: "Job",
        title: "Job",
        triggerSignalId: "trigger",
        steps: agents.map((a) => ({ agentId: a.id, description: "test" })),
        behavior: "sequential",
      },
    ],
  };
}

interface ClassificationSnapshot {
  agentId: string;
  kind: "bundled" | "llm";
  bundledId?: string;
  mcpTools?: string[];
}

function classifyAndSnapshot(plan: WorkspacePlan): ClassificationSnapshot[] {
  return classifyAgents(plan).map((c) => ({
    agentId: c.id,
    kind: c.type.kind,
    bundledId: c.type.kind === "bundled" ? c.type.bundledId : undefined,
    mcpTools: c.type.kind === "llm" ? c.type.mcpTools : undefined,
  }));
}

function mcpServers(plan: WorkspacePlan) {
  return generateMCPServers(plan.agents);
}

async function mcpServerIds(plan: WorkspacePlan): Promise<string[]> {
  const servers = await mcpServers(plan);
  return servers.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Suite 1: Compose/send scenarios → bundled email is correct
// ---------------------------------------------------------------------------

describe("Bundled Email (Send/Compose) — should classify as bundled", () => {
  it('needs: ["email"] → bundled email', () => {
    const plan = makePlan([
      {
        id: "notifier",
        name: "Email Notifier",
        description: "Sends email notification",
        needs: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);
    expect(result).toEqual([
      { agentId: "notifier", kind: "bundled", bundledId: "email", mcpTools: undefined },
    ]);
  });

  it('needs: ["notifications"] → LLM (ambiguous: both email and slack claim "notifications")', () => {
    const plan = makePlan([
      {
        id: "notifier",
        name: "Notifier",
        description: "Sends notifications",
        needs: ["notifications"],
      },
    ]);
    const result = classifyAndSnapshot(plan);
    // Both email and slack bundled agents have "notifications" capability
    // → matchBundledAgents returns 2 matches → ambiguous → falls to LLM
    expect(result).toEqual([
      { agentId: "notifier", kind: "llm", bundledId: undefined, mcpTools: ["notifications"] },
    ]);
  });

  it('needs: ["email"] generates no gmail MCP server', async () => {
    const plan = makePlan([
      { id: "sender", name: "Email Sender", description: "Sends email", needs: ["email"] },
    ]);
    const servers = await mcpServerIds(plan);
    expect(servers).not.toContain("google-gmail");
  });

  it("investor briefing plan: email agent → bundled, calendar → bundled", () => {
    const plan = makePlan([
      {
        id: "calendar-reader",
        name: "Calendar Reader",
        description: "Reads calendar events",
        needs: ["google-calendar"],
      },
      {
        id: "researcher",
        name: "Researcher",
        description: "Researches companies",
        needs: ["research"],
      },
      {
        id: "email-sender",
        name: "Email Sender",
        description: "Sends briefing email",
        needs: ["email"],
        configuration: { recipient: "vc@example.com" },
      },
    ]);
    const result = classifyAndSnapshot(plan);
    expect(result).toEqual([
      {
        agentId: "calendar-reader",
        kind: "bundled",
        bundledId: "google-calendar",
        mcpTools: undefined,
      },
      { agentId: "researcher", kind: "bundled", bundledId: "research", mcpTools: undefined },
      { agentId: "email-sender", kind: "bundled", bundledId: "email", mcpTools: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Inbox access scenarios → should route to google-gmail MCP
// ---------------------------------------------------------------------------

describe("Gmail MCP (Read/Search Inbox) — classification results", () => {
  it('needs: ["gmail"] → llm + google-gmail MCP', () => {
    const plan = makePlan([
      {
        id: "inbox-reader",
        name: "Inbox Reader",
        description: "Reads Gmail inbox",
        needs: ["gmail"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toContain("gmail");
  });

  it('needs: ["google-gmail"] → llm + google-gmail MCP', () => {
    const plan = makePlan([
      {
        id: "inbox-searcher",
        name: "Inbox Searcher",
        description: "Searches Gmail for invoices",
        needs: ["google-gmail"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toContain("google-gmail");
  });

  it('needs: ["google-gmail"] — generates google-gmail MCP server with valid config', async () => {
    const plan = makePlan([
      {
        id: "inbox-reader",
        name: "Inbox Reader",
        description: "Reads inbox",
        needs: ["google-gmail"],
      },
    ]);
    const servers = await mcpServers(plan);

    // Both classifyAgents and generateMCPServers use findFullBundledMatch,
    // so they agree: "google-gmail" is NOT bundled → MCP server generated
    expect(servers.length).toBeGreaterThan(0);
    const gmail = servers.find((s) => s.id === "google-gmail");
    expect(gmail).toBeDefined();
    expect(gmail?.config).toBeDefined();
  });

  it('needs: ["inbox"] — CURRENT: llm (correct for inbox access)', () => {
    const plan = makePlan([
      {
        id: "inbox-monitor",
        name: "Inbox Monitor",
        description: "Monitors email inbox",
        needs: ["inbox"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // "inbox" is NOT a bundled email capability, so it falls through to LLM
    // This is actually correct behavior — it would get google-gmail MCP
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["inbox"]);
  });

  it('needs: ["inbox"] generates google-gmail MCP server (correct)', async () => {
    const plan = makePlan([
      {
        id: "inbox-monitor",
        name: "Inbox Monitor",
        description: "Monitors inbox",
        needs: ["inbox"],
      },
    ]);
    const servers = await mcpServerIds(plan);

    // "inbox" is a domain of google-gmail MCP → correctly matched
    expect(servers).toContain("google-gmail");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Mixed workflows — both bundled email AND Gmail in same plan
// ---------------------------------------------------------------------------

describe("Mixed Workflows — read inbox + send email", () => {
  it("gmail reader + email sender: reader → LLM, sender → bundled email", () => {
    const plan = makePlan([
      {
        id: "gmail-reader",
        name: "Gmail Reader",
        description: "Reads Gmail for meeting invites",
        needs: ["gmail"],
      },
      {
        id: "email-sender",
        name: "Email Sender",
        description: "Sends summary email",
        needs: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // Gmail reader → LLM + google-gmail MCP
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toContain("gmail");

    // Email sender → bundled email
    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("email");
  });

  it("google-gmail reader + email sender: reader → LLM, sender → bundled email", () => {
    const plan = makePlan([
      {
        id: "gmail-reader",
        name: "Gmail Reader",
        description: "Searches Gmail for client emails",
        needs: ["google-gmail"],
      },
      {
        id: "email-sender",
        name: "Summary Sender",
        description: "Emails summary",
        needs: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // google-gmail reader → LLM
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toContain("google-gmail");

    // Email sender → bundled email
    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("email");
  });

  it("inbox reader + email sender: reader correct, sender correct", () => {
    const plan = makePlan([
      {
        id: "inbox-reader",
        name: "Inbox Reader",
        description: "Reads inbox for client emails",
        needs: ["inbox"],
      },
      {
        id: "email-sender",
        name: "Summary Sender",
        description: "Emails summary",
        needs: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // "inbox" correctly falls through to LLM (not a bundled capability)
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["inbox"]);

    // "email" correctly matched as bundled
    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("email");
  });

  it("calendar + gmail reader + email sender: triple routing", () => {
    const plan = makePlan([
      {
        id: "calendar-reader",
        name: "Calendar Reader",
        description: "Reads Google Calendar events",
        needs: ["google-calendar"],
      },
      {
        id: "gmail-reader",
        name: "Gmail Reader",
        description: "Reads unread Gmail messages",
        needs: ["gmail"],
      },
      {
        id: "digest-sender",
        name: "Digest Sender",
        description: "Sends weekly digest email",
        needs: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // Calendar: correctly bundled
    expect(result[0]?.kind).toBe("bundled");
    expect(result[0]?.bundledId).toBe("google-calendar");

    // Gmail reader → LLM + google-gmail MCP
    expect(result[1]?.kind).toBe("llm");
    expect(result[1]?.mcpTools).toContain("gmail");

    // Email sender: correctly bundled
    expect(result[2]?.kind).toBe("bundled");
    expect(result[2]?.bundledId).toBe("email");
  });

  it('single agent needs: ["email", "gmail"] → LLM + generates google-gmail MCP', async () => {
    const plan = makePlan([
      {
        id: "email-manager",
        name: "Email Manager",
        description: "Reads inbox and sends replies",
        needs: ["email", "gmail"],
      },
    ]);
    // Partial coverage: bundled email covers "email" but not "gmail" → falls to LLM
    expect(classifyAndSnapshot(plan)[0]?.kind).toBe("llm");
    const servers = await mcpServerIds(plan);
    expect(servers).toContain("google-gmail");
  });

  it("triple routing MCP server generation — consistent after fix", async () => {
    const plan = makePlan([
      {
        id: "calendar-reader",
        name: "Calendar Reader",
        description: "Reads calendar",
        needs: ["google-calendar"],
      },
      { id: "gmail-reader", name: "Gmail Reader", description: "Reads Gmail", needs: ["gmail"] },
      { id: "digest-sender", name: "Digest Sender", description: "Sends email", needs: ["email"] },
    ]);
    const servers = await mcpServerIds(plan);

    // generateMCPServers now uses extractKeywordsFromNeed (same as classifyAgents):
    // "google-calendar" → extracts "calendar" → matches bundled → no MCP
    // "gmail" → no bundled match → MCP generated (google-gmail)
    // "email" → matches bundled email → no MCP
    expect(servers).not.toContain("google-calendar");
    expect(servers).toContain("google-gmail");
    expect(servers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Sentry ATLAS-29X exact reproduction
// ---------------------------------------------------------------------------

describe("Sentry ATLAS-29X — cron-triggered Gmail inbox polling", () => {
  it("exact scenario: 15-min cron polling Gmail inbox", () => {
    // This is the exact plan shape from the Sentry issue
    const plan = makePlan([
      {
        id: "gmail-checker",
        name: "Gmail Checker",
        description: "Checks Gmail inbox for new messages from the sales team every 15 minutes",
        needs: ["gmail"],
      },
      {
        id: "slack-notifier",
        name: "Slack Notifier",
        description: "Sends Slack notification when relevant emails found",
        needs: ["slack"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // Gmail checker → LLM with google-gmail MCP (no longer intercepted by bundled email)
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toContain("gmail");

    // Slack: correctly bundled
    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("slack");
  });

  it("ATLAS-29X: google-gmail MCP server correctly generated", async () => {
    const plan = makePlan([
      {
        id: "gmail-checker",
        name: "Gmail Checker",
        description: "Polls Gmail inbox",
        needs: ["gmail"],
      },
      {
        id: "slack-notifier",
        name: "Slack Notifier",
        description: "Notifies via Slack",
        needs: ["slack"],
      },
    ]);
    const servers = await mcpServerIds(plan);

    // "gmail" no longer matches bundled email → MCP server generated
    expect(servers).toContain("google-gmail");
  });

  it('workaround: needs: ["inbox"] correctly routes to gmail MCP', () => {
    // This demonstrates that "inbox" (not a bundled capability) works correctly
    const plan = makePlan([
      {
        id: "inbox-checker",
        name: "Inbox Checker",
        description: "Polls inbox for new messages",
        needs: ["inbox"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // "inbox" is NOT in bundled email capabilities → falls through to LLM
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["inbox"]);
  });

  it('workaround: "inbox" generates google-gmail MCP', async () => {
    const plan = makePlan([
      { id: "inbox-checker", name: "Inbox Checker", description: "Polls inbox", needs: ["inbox"] },
    ]);
    const servers = await mcpServerIds(plan);
    expect(servers).toContain("google-gmail");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: The substring matching problem — root cause demonstration
// ---------------------------------------------------------------------------

describe("Root cause: substring matching in extractKeywordsFromNeed", () => {
  it("gmail → LLM (no longer a bundled email capability)", () => {
    const plan = makePlan([{ id: "a", name: "A", description: "A", needs: ["gmail"] }]);
    // "gmail" removed from email agent capabilities → falls through to LLM
    expect(classifyAndSnapshot(plan)[0]?.kind).toBe("llm");
  });

  it("google-gmail → LLM (substring 'gmail' no longer matches bundled)", () => {
    const plan = makePlan([{ id: "a", name: "A", description: "A", needs: ["google-gmail"] }]);
    // extractKeywordsFromNeed("google-gmail") → includes("gmail") → ["gmail"]
    // matchBundledAgents(["gmail"]) → no match (gmail removed from email agent)
    expect(classifyAndSnapshot(plan)[0]?.kind).toBe("llm");
  });

  it("inbox → NOT bundled (not in email agent capabilities)", () => {
    const plan = makePlan([{ id: "a", name: "A", description: "A", needs: ["inbox"] }]);
    // "inbox" is not a capability of any bundled agent → falls through
    expect(classifyAndSnapshot(plan)[0]?.kind).toBe("llm");
  });

  it("email → bundled email (correct)", () => {
    const plan = makePlan([{ id: "a", name: "A", description: "A", needs: ["email"] }]);
    expect(classifyAndSnapshot(plan)[0]?.bundledId).toBe("email");
  });

  it("google-calendar → bundled google-calendar (correct, no substring issue)", () => {
    const plan = makePlan([{ id: "a", name: "A", description: "A", needs: ["google-calendar"] }]);
    // "google-calendar" includes "calendar" → extracts "calendar" → matches google-calendar bundled
    expect(classifyAndSnapshot(plan)[0]?.bundledId).toBe("google-calendar");
  });
});
