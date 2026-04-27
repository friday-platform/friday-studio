/**
 * Email vs Gmail Classification Pipeline Tests
 *
 * Tests the production classification pipeline with exact registry IDs:
 *   WorkspacePlan → classifyAgents() → generateMCPServers()
 *
 * With capabilities constrained to exact registry IDs, email vs Gmail
 * disambiguation is structural: "email" → bundled agent registry,
 * "google-gmail" → MCP servers registry. No keyword matching means no
 * ambiguity.
 *
 * Background: Sentry ATLAS-29X — now structurally impossible since "email"
 * and "google-gmail" are distinct IDs in different registries.
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { classifyAgents } from "./agent-classifier.ts";
import { generateMCPServers } from "./enrichers/mcp-servers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function mcpServerIds(plan: WorkspacePlan): string[] {
  const servers = generateMCPServers(plan.agents);
  return servers.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Bundled email (send-only via SendGrid)
// ---------------------------------------------------------------------------

describe("Bundled Email — registry lookup", () => {
  it('capabilities: ["email"] → bundled email', () => {
    const plan = makePlan([
      {
        id: "notifier",
        name: "Email Notifier",
        description: "Sends email notification",
        capabilities: ["email"],
      },
    ]);
    expect(classifyAndSnapshot(plan)).toEqual([
      { agentId: "notifier", kind: "bundled", bundledId: "email", mcpTools: undefined },
    ]);
  });

  it('capabilities: ["email"] generates no MCP servers', () => {
    const plan = makePlan([
      { id: "sender", name: "Email Sender", description: "Sends email", capabilities: ["email"] },
    ]);
    const servers = mcpServerIds(plan);
    expect(servers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gmail MCP (full inbox access via OAuth)
// ---------------------------------------------------------------------------

describe("Gmail MCP — registry lookup", () => {
  it('capabilities: ["google-gmail"] → LLM with MCP', () => {
    const plan = makePlan([
      {
        id: "inbox-reader",
        name: "Inbox Reader",
        description: "Reads Gmail inbox",
        capabilities: ["google-gmail"],
      },
    ]);
    const result = classifyAndSnapshot(plan);
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["google-gmail"]);
  });

  it('capabilities: ["google-gmail"] generates google-gmail MCP server', () => {
    const plan = makePlan([
      {
        id: "inbox-reader",
        name: "Inbox Reader",
        description: "Reads inbox",
        capabilities: ["google-gmail"],
      },
    ]);
    const servers = mcpServerIds(plan);
    expect(servers).toContain("google-gmail");
  });
});

// ---------------------------------------------------------------------------
// Mixed workflows — both bundled email AND Gmail in same plan
// ---------------------------------------------------------------------------

describe("Mixed Workflows — read inbox + send email", () => {
  it("google-gmail reader + email sender: reader → LLM, sender → bundled", () => {
    const plan = makePlan([
      {
        id: "gmail-reader",
        name: "Gmail Reader",
        description: "Reads Gmail",
        capabilities: ["google-gmail"],
      },
      {
        id: "email-sender",
        name: "Email Sender",
        description: "Sends email",
        capabilities: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["google-gmail"]);

    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("email");
  });

  it("investor briefing: calendar + research (bundled) + email (bundled)", () => {
    const plan = makePlan([
      {
        id: "cal-reader",
        name: "Calendar Reader",
        description: "Reads events",
        capabilities: ["google-calendar"],
      },
      {
        id: "researcher",
        name: "Researcher",
        description: "Researches companies",
        capabilities: ["research"],
      },
      {
        id: "email-sender",
        name: "Email Sender",
        description: "Sends briefing",
        capabilities: ["email"],
      },
    ]);
    const result = classifyAndSnapshot(plan);
    expect(result).toEqual([
      { agentId: "cal-reader", kind: "bundled", bundledId: "google-calendar", mcpTools: undefined },
      // `research` aliases the canonical `web` bundled agent.
      { agentId: "researcher", kind: "bundled", bundledId: "web", mcpTools: undefined },
      { agentId: "email-sender", kind: "bundled", bundledId: "email", mcpTools: undefined },
    ]);
  });

  it("triple routing: calendar (bundled) + gmail (MCP) + email (bundled)", () => {
    const plan = makePlan([
      {
        id: "cal-reader",
        name: "Calendar",
        description: "Reads calendar",
        capabilities: ["google-calendar"],
      },
      {
        id: "gmail-reader",
        name: "Gmail",
        description: "Reads Gmail",
        capabilities: ["google-gmail"],
      },
      { id: "digest-sender", name: "Digest", description: "Sends email", capabilities: ["email"] },
    ]);
    const result = classifyAndSnapshot(plan);
    expect(result[0]?.kind).toBe("bundled");
    expect(result[1]?.kind).toBe("llm");
    expect(result[2]?.kind).toBe("bundled");

    const servers = mcpServerIds(plan);
    expect(servers).toEqual(["google-gmail"]);
  });
});

// ---------------------------------------------------------------------------
// Sentry ATLAS-29X — structurally impossible with registry lookup
// ---------------------------------------------------------------------------

describe("Sentry ATLAS-29X — structurally prevented", () => {
  it("email and google-gmail are in different registries — no cross-contamination", () => {
    const plan = makePlan([
      {
        id: "gmail-checker",
        name: "Gmail Checker",
        description: "Checks Gmail",
        capabilities: ["google-gmail"],
      },
      {
        id: "slack-notifier",
        name: "Slack Notifier",
        description: "Notifies Slack",
        capabilities: ["slack"],
      },
    ]);
    const result = classifyAndSnapshot(plan);

    // google-gmail → MCP (not bundled email)
    expect(result[0]?.kind).toBe("llm");
    expect(result[0]?.mcpTools).toEqual(["google-gmail"]);

    // slack → bundled
    expect(result[1]?.kind).toBe("bundled");
    expect(result[1]?.bundledId).toBe("slack");
  });

  it("google-gmail generates MCP server, not bundled email", () => {
    const plan = makePlan([
      {
        id: "gmail-checker",
        name: "Gmail Checker",
        description: "Polls Gmail",
        capabilities: ["google-gmail"],
      },
    ]);
    const servers = mcpServerIds(plan);
    expect(servers).toContain("google-gmail");
  });
});
