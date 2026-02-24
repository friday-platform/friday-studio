/**
 * Unit tests for agent classification via direct registry lookup.
 *
 * With capabilities constrained to exact registry IDs (z.enum), classification
 * is a simple lookup: bundled registry → bundled agent, MCP registry → LLM with
 * MCP tools, neither → unknown.
 *
 * Ref: Sentry ATLAS-29X — email agent selected for Gmail retrieval,
 * causing 734 recurring errors. Now structurally impossible since "email" and
 * "google-gmail" are distinct IDs in different registries.
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { classifyAgents } from "./agent-classifier.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makePlan(agents: WorkspacePlan["agents"]): WorkspacePlan {
  return { workspace: { name: "test", purpose: "test" }, signals: [], agents, jobs: [] };
}

function classify(capabilities: string[]) {
  const plan = makePlan([
    { id: "test-agent", name: "Test Agent", description: "test", capabilities },
  ]);
  const classified = classifyAgents(plan);
  const agent = classified[0];
  if (!agent) throw new Error("Expected exactly one classified agent");
  return agent;
}

// ---------------------------------------------------------------------------
// Registry lookup — bundled agents
// ---------------------------------------------------------------------------

describe("classifyAgents — bundled agent registry lookup", () => {
  it.each([
    { name: "email → bundled email", capabilities: ["email"], bundledId: "email" },
    { name: "slack → bundled slack", capabilities: ["slack"], bundledId: "slack" },
    {
      name: "google-calendar → bundled google-calendar",
      capabilities: ["google-calendar"],
      bundledId: "google-calendar",
    },
    { name: "research → bundled research", capabilities: ["research"], bundledId: "research" },
  ])("$name", ({ capabilities, bundledId }) => {
    const agent = classify(capabilities);
    expect(agent.type.kind).toBe("bundled");
    expect(agent.type).toMatchObject({ bundledId });
  });
});

// ---------------------------------------------------------------------------
// Registry lookup — MCP servers
// ---------------------------------------------------------------------------

describe("classifyAgents — MCP server registry lookup", () => {
  it.each([
    { name: "google-gmail → LLM with MCP", capabilities: ["google-gmail"] },
    { name: "github → LLM with MCP", capabilities: ["github"] },
    { name: "google-sheets → LLM with MCP", capabilities: ["google-sheets"] },
    { name: "linear → LLM with MCP", capabilities: ["linear"] },
  ])("$name", ({ capabilities }) => {
    const agent = classify(capabilities);
    expect(agent.type.kind).toBe("llm");
    expect(agent.type).toMatchObject({ mcpTools: capabilities });
  });
});

// ---------------------------------------------------------------------------
// First-match-wins — bundled takes precedence over later capabilities
// ---------------------------------------------------------------------------

describe("classifyAgents — first-match-wins", () => {
  it("returns first bundled match, ignoring subsequent capabilities", () => {
    const agent = classify(["research", "email"]);
    expect(agent.type.kind).toBe("bundled");
    expect(agent.type).toMatchObject({ bundledId: "research" });
  });
});

// ---------------------------------------------------------------------------
// Empty capabilities — plain LLM agent
// ---------------------------------------------------------------------------

describe("classifyAgents — empty capabilities", () => {
  it("empty capabilities → plain LLM agent", () => {
    const agent = classify([]);
    expect(agent.type.kind).toBe("llm");
    expect(agent.type).toMatchObject({ mcpTools: [] });
  });
});

// ---------------------------------------------------------------------------
// Email vs Gmail disambiguation (structural — different registries)
// ---------------------------------------------------------------------------

describe("classifyAgents — email vs gmail disambiguation", () => {
  it("email → bundled (send-only via SendGrid)", () => {
    const agent = classify(["email"]);
    expect(agent.type.kind).toBe("bundled");
    expect(agent.type).toMatchObject({ bundledId: "email" });
  });

  it("google-gmail → LLM with MCP (full inbox access via OAuth)", () => {
    const agent = classify(["google-gmail"]);
    expect(agent.type.kind).toBe("llm");
  });
});
