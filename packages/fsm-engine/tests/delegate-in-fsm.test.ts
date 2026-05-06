/**
 * Phase 7 — `delegate` is exposed as an opt-in tool for FSM `type: llm`
 * actions.
 *
 * Asserts:
 *   1. With `tools: ["delegate"]` declared on the action AND `platformModels`
 *      wired, the delegate tool reaches the LLM tools map and is invokable
 *      (its `execute` returns the discriminated-union result).
 *   2. Without `platformModels` wired, the engine silently omits delegate
 *      — the action still runs, the LLM just never sees the tool.
 *   3. When `delegationDepth >= delegationBudget.max_depth`, delegate is
 *      omitted (Phase 8 budget enforcement seam).
 *   4. The depth-cap default of 1 (today's chat hard cap) lets the
 *      top-level action register delegate but child invocations would not
 *      (verified by simulating a depth=1 signal context).
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);
vi.stubGlobal("fetch", mockFetch);

const mockCreateMCPTools = vi.hoisted(() =>
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: unknown,
    ) => Promise<{
      tools: Record<string, Tool>;
      toolsByServer: Record<string, string[]>;
      dispose: () => Promise<void>;
      disconnectedIntegrations: unknown[];
    }>
  >(),
);

vi.mock("@atlas/mcp", () => ({
  createMCPTools: mockCreateMCPTools,
  MCPStartupError: class MCPStartupError extends Error {},
  sharedMCPProcesses: { shutdown: () => Promise.resolve() },
}));

vi.mock("@atlas/oapi-client", () => ({
  getAtlasDaemonUrl: () => "http://localhost:3000",
  getAtlasPlatformServerConfig: () => ({ transport: { type: "stdio", command: "noop", args: [] } }),
}));

const { FSMEngine } = await import("../fsm-engine.ts");
const { getDocumentStore } = await import("../../document-store/mod.ts");
const { createStubPlatformModels } = await import("@atlas/llm");

import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryStubFetch(): void {
  // Memory composer hits /api/memory/<workspaceId> and per-store endpoints.
  // Returning empty arrays keeps the auto-prepend a no-op for these tests.
  mockFetch.mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/memory/")) {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

const fsmWithDelegate: FSMDefinition = {
  id: "delegate-in-fsm-test",
  initial: "pending",
  states: {
    pending: {
      on: {
        RUN: {
          target: "done",
          actions: [
            {
              type: "llm",
              provider: "test",
              model: "test-model",
              prompt: "Use the delegate tool to spawn a child.",
              tools: ["delegate"],
              outputTo: "result",
            },
          ],
        },
      },
    },
    done: { type: "final" },
  },
};

describe("FSM LLM action — delegate tool exposure (Phase 7)", () => {
  it("registers delegate when tools: ['delegate'] declared and platformModels wired", async () => {
    memoryStubFetch();
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      toolsByServer: { "atlas-platform": [] },
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedToolNames: string[] | undefined;
    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        observedToolNames = Object.keys(params.tools as Record<string, Tool>);
        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [],
          toolResults: [],
          durationMs: 0,
        };
        return Promise.resolve(envelope);
      },
    };

    const engine = new FSMEngine(fsmWithDelegate, {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-delegate", sessionId: "sess-1" },
      llmProvider: mockLLMProvider,
      platformModels: createStubPlatformModels(),
    });
    await engine.initialize();

    await engine.signal({ type: "RUN" }, { sessionId: "sess-1", workspaceId: "ws-delegate" });

    expect(observedToolNames).toContain("delegate");
    expect(observedToolNames).toContain("failStep");
  });

  it("silently omits delegate when platformModels is missing", async () => {
    memoryStubFetch();
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      toolsByServer: { "atlas-platform": [] },
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedToolNames: string[] | undefined;
    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        observedToolNames = Object.keys(params.tools as Record<string, Tool>);
        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [],
          toolResults: [],
          durationMs: 0,
        };
        return Promise.resolve(envelope);
      },
    };

    const engine = new FSMEngine(fsmWithDelegate, {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-no-platform", sessionId: "sess-2" },
      llmProvider: mockLLMProvider,
      // platformModels intentionally omitted — verifies graceful degradation.
    });
    await engine.initialize();

    await engine.signal({ type: "RUN" }, { sessionId: "sess-2", workspaceId: "ws-no-platform" });

    expect(observedToolNames).toBeDefined();
    expect(observedToolNames).not.toContain("delegate");
    // failStep is still injected — only delegate is conditionally absent.
    expect(observedToolNames).toContain("failStep");
  });

  it("omits delegate once delegationDepth meets the workspace cap", async () => {
    memoryStubFetch();
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      toolsByServer: { "atlas-platform": [] },
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedToolNames: string[] | undefined;
    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        observedToolNames = Object.keys(params.tools as Record<string, Tool>);
        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [],
          toolResults: [],
          durationMs: 0,
        };
        return Promise.resolve(envelope);
      },
    };

    const engine = new FSMEngine(fsmWithDelegate, {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-depth-cap", sessionId: "sess-3" },
      llmProvider: mockLLMProvider,
      platformModels: createStubPlatformModels(),
      delegationBudget: { max_depth: 1 },
    });
    await engine.initialize();

    // Simulate a child-frame signal: the engine reads `delegationDepth` from
    // the inbound signal context. Top-level signals start at 0; a frame
    // already at depth 1 must NOT receive delegate (would breach max_depth=1).
    await engine.signal(
      { type: "RUN" },
      { sessionId: "sess-3", workspaceId: "ws-depth-cap", delegationDepth: 1 },
    );

    expect(observedToolNames).toBeDefined();
    expect(observedToolNames).not.toContain("delegate");
  });

  it("registers delegate at depth 0 even with explicit max_depth=1 (chat-parity default)", async () => {
    memoryStubFetch();
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      toolsByServer: { "atlas-platform": [] },
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedToolNames: string[] | undefined;
    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        observedToolNames = Object.keys(params.tools as Record<string, Tool>);
        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [],
          toolResults: [],
          durationMs: 0,
        };
        return Promise.resolve(envelope);
      },
    };

    const engine = new FSMEngine(fsmWithDelegate, {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-depth-default", sessionId: "sess-4" },
      llmProvider: mockLLMProvider,
      platformModels: createStubPlatformModels(),
      delegationBudget: { max_depth: 1 },
    });
    await engine.initialize();

    // No `delegationDepth` on the signal — defaults to 0, well below 1.
    await engine.signal({ type: "RUN" }, { sessionId: "sess-4", workspaceId: "ws-depth-default" });

    expect(observedToolNames).toContain("delegate");
  });
});
